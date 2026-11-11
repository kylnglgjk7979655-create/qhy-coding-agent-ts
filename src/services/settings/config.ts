import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AgentError } from '../../utils/errors.js';

export const DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS = 300_000;

const contextSchema = z.strictObject({
  capacityTokens: z.number().int().min(1).max(10_000_000).default(128_000),
  answerReserveTokens: z.number().int().min(1).max(10_000_000).default(8192),
  triggerRatio: z.number().gt(0).lte(1).default(0.8),
  targetRatio: z.number().gt(0).lt(1).default(0.5),
  keepRecentTurns: z.number().int().min(0).max(100).default(2),
}).superRefine((context, ctx) => {
  if (context.answerReserveTokens >= context.capacityTokens) {
    ctx.addIssue({ code: 'custom', path: ['answerReserveTokens'], message: '回答预留必须小于上下文容量' });
  }
  if (context.targetRatio >= context.triggerRatio) {
    ctx.addIssue({ code: 'custom', path: ['targetRatio'], message: '压缩目标必须小于触发阈值' });
  }
});

export const DEFAULT_CONTEXT = contextSchema.parse({});

const baseURLSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash;
}, 'baseURL 必须为 HTTP(S) 地址，且不能包含凭据、查询参数或片段');

const apiKeyEnvSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const operationTimeoutSchema = z.number().int().min(1).max(3_600_000);
const mcpServerSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/),
  url: baseURLSchema,
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.strictObject({ env: apiKeyEnvSchema })).default({}),
}).superRefine((server, ctx) => {
  const names = Object.keys(server.headers).map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length || names.some((name) =>
    ['host', 'content-length', 'content-type', 'accept', 'connection', 'mcp-session-id', 'mcp-protocol-version'].includes(name))) {
    ctx.addIssue({ code: 'custom', path: ['headers'], message: '请求头重复或覆盖协议保留字段' });
  }
});
const reviewModelSchema = z.strictObject({
  provider: z.literal('openai').default('openai'),
  model: z.string().trim().min(1),
  apiKeyEnv: apiKeyEnvSchema.optional(),
  baseURL: baseURLSchema.optional(),
});
const exploreConfigSchema = z.strictObject({
  model: z.string().trim().min(1).optional(),
  loadRootAgents: z.boolean().default(false),
});

const permissionRuleSchema = z.string().trim().min(1).refine((rule) => {
  const match = /^(Read|Write|Glob|Grep|Bash|MCP|Agent|RuntimeInfo)(?:\(([^()]+)\))?$/u.exec(rule);
  if (!match) return false;
  const [, kind, argument] = match;
  if (['Read', 'Write', 'Glob', 'Grep'].includes(kind!)) return argument === undefined || argument.trim().length > 0;
  if (kind === 'Bash') return argument !== undefined && argument.trim().length > 0
    && (!/[?*]/u.test(argument) || argument.endsWith(':*'));
  if (kind === 'MCP') return argument === undefined || /^[a-z][a-z0-9-]{0,15}\/(?:\*|[^\s()*][^\s()]*)$/u.test(argument);
  return argument === undefined;
}, '权限规则语法无效');

export const configSchema = z.strictObject({
  provider: z.literal('openai').default('openai'),
  model: z.string().trim().min(1).default('gpt-4.1-mini-2025-04-14'),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('OPENAI_API_KEY'),
  baseURL: baseURLSchema.optional(),
  workspace: z.string().trim().min(1).default('.'),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(60_000),
  maxSteps: z.number().int().min(1).max(100).default(20),
  explore: exploreConfigSchema.optional(),
  context: contextSchema.optional(),
  mcp: z.strictObject({
    servers: z.array(mcpServerSchema).refine((servers) => new Set(servers.map(({ name }) => name)).size === servers.length, 'MCP 服务名称重复'),
    connectTimeoutMs: operationTimeoutSchema.default(10_000),
    discoveryTimeoutMs: operationTimeoutSchema.default(10_000),
    callTimeoutMs: operationTimeoutSchema.default(30_000),
  }).optional(),
  bash: z.strictObject({
    timeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
  }).optional(),
  approval: z.strictObject({
    mode: z.enum(['default', 'auto']).default('default'),
    // 保留旧字段的严格解析，避免旧 settings 因迁移字段形状而破损；运行时不应用其中授权。
    rules: z.array(z.strictObject({
      toolName: z.string().trim().min(1),
      action: z.enum(['allow', 'deny', 'ask']),
    })).optional(),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
    humanTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    model: reviewModelSchema.optional(),
  }).default({ mode: 'default', timeoutMs: 30_000 }),
  permissions: z.strictObject({
    allow: z.array(permissionRuleSchema).default([]),
    ask: z.array(permissionRuleSchema).default([]),
    deny: z.array(permissionRuleSchema).default([]),
  }).optional(),
});

export type ModelConfig = z.infer<typeof configSchema>;
export type ResolvedConfig = ModelConfig & {
  apiKey: string;
  approvalApiKey?: string;
  mcpHeaders?: Record<string, Record<string, string>>;
  migrationWarnings?: string[];
};

interface ConfigOptions {
  cwd: string;
  workspace?: string;
  env: NodeJS.ProcessEnv;
  home?: string;
}

const permissionKeys = ['allow', 'ask', 'deny'] as const;
const legacyConfigName = 'agent.config.json';

export async function loadConfig(options: ConfigOptions): Promise<ResolvedConfig> {
  const home = options.home ?? options.env.HOME ?? options.env.USERPROFILE ?? homedir();
  const userSettingsPath = join(home, '.agent', 'settings.json');
  const userSettings = await readSettings(userSettingsPath, false);
  const userWorkspace = typeof userSettings.workspace === 'string' ? userSettings.workspace : undefined;
  const workspaceInput = options.workspace ?? userWorkspace ?? '.';
  const workspacePath = resolve(options.cwd, workspaceInput);
  let workspace: string;
  try {
    workspace = await realpath(workspacePath);
    if (!(await stat(workspace)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new AgentError('CONFIG_ERROR', '工作区不存在或不是可访问目录，请检查 --workspace。');
  }

  const projectSettingsPath = join(workspace, '.agent', 'settings.json');
  const localSettingsPath = join(workspace, '.agent', 'settings.local.json');
  const legacyPaths = [...new Set([resolve(options.cwd, legacyConfigName), join(workspace, legacyConfigName)])];
  const migrationWarnings = (await Promise.all(legacyPaths.map(async (path) => (await isFile(path)) ? path : undefined)))
    .filter((path): path is string => path !== undefined)
    .map((path) => `发现旧配置 ${path}；该文件不会加载，请迁移到 settings.json。`);
  for (const warning of migrationWarnings) process.stderr.write(`迁移提示：${warning}\n`);
  const projectSettings = await readSettings(projectSettingsPath, true);
  const localSettings = await readSettings(localSettingsPath, true);
  if ('workspace' in projectSettings || 'workspace' in localSettings) {
    throw new AgentError('CONFIG_ERROR', '项目 settings 不能设置 workspace；请使用 --workspace 或用户级 settings。');
  }

  const raw = mergeSettings(mergeSettings(userSettings, projectSettings), localSettings);
  raw.workspace = workspace;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '配置根对象'))];
    throw new AgentError('CONFIG_ERROR', `配置无效，请检查字段：${fields.join('、')}。`);
  }

  const config = parsed.data;
  const apiKey = options.env[config.apiKeyEnv]?.trim();
  if (!apiKey) throw new AgentError('CONFIG_ERROR', `缺少凭据：请在环境变量或 .env 中设置 ${config.apiKeyEnv}。`);
  const reviewKeyEnv = config.approval.model?.apiKeyEnv;
  const approvalApiKey = reviewKeyEnv === undefined ? undefined : options.env[reviewKeyEnv]?.trim();
  if (reviewKeyEnv !== undefined && !approvalApiKey) throw new AgentError('CONFIG_ERROR', `缺少审批凭据：请设置环境变量 ${reviewKeyEnv}。`);
  const mcpHeaders = resolveMcpHeaders(config, options.env);
  return { ...config, workspace, apiKey, mcpHeaders, ...(approvalApiKey === undefined ? {} : { approvalApiKey }),
    ...(migrationWarnings.length === 0 ? {} : { migrationWarnings }) };
}

export async function restoreSessionConfig(config: ModelConfig, env: NodeJS.ProcessEnv): Promise<ResolvedConfig> {
  try {
    return await loadConfig({ cwd: config.workspace, workspace: config.workspace, env });
  } catch (error) {
    if (error instanceof AgentError && error.message.includes('工作区不存在或不是可访问目录')) {
      throw new AgentError('CONFIG_ERROR', `会话工作区不可用：${config.workspace}。`);
    }
    throw error;
  }
}

async function readSettings(path: string, project: boolean): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return {};
    throw new AgentError('CONFIG_ERROR', `无法读取 settings 文件：${path}。`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch {
    throw new AgentError('CONFIG_ERROR', `settings 文件不是有效 JSON：${path}。`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AgentError('CONFIG_ERROR', `settings 文件根节点必须是对象：${path}。`);
  }
  if (project && 'workspace' in raw) {
    throw new AgentError('CONFIG_ERROR', '项目 settings 不能设置 workspace；请使用 --workspace 或用户级 settings。');
  }
  validateSettingsLayer(raw as Record<string, unknown>, path);
  return raw as Record<string, unknown>;
}

function validateSettingsLayer(raw: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(raw)) {
    const field = configSchema.shape[key as keyof typeof configSchema.shape];
    if (!field || !field.safeParse(value).success) {
      throw new AgentError('CONFIG_ERROR', `settings 字段无效：${path}（${key}）。`);
    }
  }
}

function mergeSettings(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === 'permissions' && isRecord(value)) {
      const previous = isRecord(result.permissions) ? result.permissions : {};
      const merged: Record<string, unknown> = { ...previous, ...value };
      for (const permissionKey of permissionKeys) {
        const left = Array.isArray(previous[permissionKey]) ? previous[permissionKey] as unknown[] : [];
        const right = Array.isArray(value[permissionKey]) ? value[permissionKey] as unknown[] : [];
        if (permissionKey in previous || permissionKey in value) merged[permissionKey] = [...new Set([...left, ...right])];
      }
      result.permissions = merged;
    } else if (isRecord(value) && isRecord(result[key])) {
      result[key] = mergeSettings(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveMcpHeaders(config: ModelConfig, env: NodeJS.ProcessEnv): Record<string, Record<string, string>> {
  const mcpHeaders: Record<string, Record<string, string>> = Object.create(null);
  for (const server of config.mcp?.servers ?? []) {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, reference] of Object.entries(server.headers)) {
      const value = env[reference.env];
      if (!value?.trim() || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new AgentError('CONFIG_ERROR', `MCP 请求头环境变量缺失或无效：${reference.env}。`);
      }
      headers[name] = value;
    }
    mcpHeaders[server.name] = headers;
  }
  return mcpHeaders;
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) { if (isMissing(error)) return false; throw error; }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loggableConfig(config: ResolvedConfig): Omit<ModelConfig, 'approval'> {
  return {
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    baseURL: config.baseURL ?? 'https://api.openai.com/v1',
    workspace: config.workspace,
    timeoutMs: config.timeoutMs,
    maxSteps: config.maxSteps,
    ...(config.explore === undefined ? {} : { explore: config.explore }),
  };
}
