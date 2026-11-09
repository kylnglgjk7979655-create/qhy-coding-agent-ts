import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
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

export const configSchema = z.strictObject({
  provider: z.literal('openai').default('openai'),
  model: z.string().trim().min(1).default('gpt-4.1-mini-2025-04-14'),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('OPENAI_API_KEY'),
  baseURL: baseURLSchema.optional(),
  workspace: z.string().trim().min(1).default('./demo'),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(60_000),
  maxSteps: z.number().int().min(1).max(100).default(20),
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
    mode: z.enum(['model', 'human']).default('model'),
    rules: z.array(z.strictObject({
      toolName: z.string().trim().min(1),
      action: z.enum(['allow', 'deny', 'ask']),
    })).default([]),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
    humanTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    model: reviewModelSchema.optional(),
  }).default({ mode: 'model', rules: [], timeoutMs: 30_000 }),
});

export type ModelConfig = z.infer<typeof configSchema>;
export type ResolvedConfig = ModelConfig & { apiKey: string; approvalApiKey?: string; mcpHeaders?: Record<string, Record<string, string>> };

interface ConfigOptions {
  cwd: string;
  configPath?: string;
  workspace?: string;
  env: NodeJS.ProcessEnv;
}

export async function loadConfig(options: ConfigOptions): Promise<ResolvedConfig> {
  let contents: string | undefined;
  try {
    contents = await readFile(resolve(options.cwd, options.configPath ?? 'agent.config.json'), 'utf8');
  } catch (error) {
    if (options.configPath !== undefined || !isMissing(error)) {
      throw new AgentError('CONFIG_ERROR', '无法读取配置文件，请检查 --config 路径及文件权限。');
    }
  }

  let raw: unknown = {};
  if (contents !== undefined) {
    try {
      raw = JSON.parse(contents) as unknown;
    } catch {
      throw new AgentError('CONFIG_ERROR', '配置文件不是有效 JSON。');
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '配置根对象'))];
    throw new AgentError('CONFIG_ERROR', `配置无效，请检查字段：${fields.join('、')}。`);
  }

  const config = parsed.data;
  const workspacePath = resolve(options.cwd, options.workspace ?? config.workspace);
  let workspace: string;
  try {
    workspace = await realpath(workspacePath);
    if (!(await stat(workspace)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new AgentError('CONFIG_ERROR', '工作区不存在或不是可访问目录，请检查 --workspace。');
  }

  const apiKey = options.env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new AgentError('CONFIG_ERROR', `缺少凭据：请在环境变量或 .env 中设置 ${config.apiKeyEnv}。`);
  }
  const reviewKeyEnv = config.approval.model?.apiKeyEnv;
  const approvalApiKey = reviewKeyEnv === undefined ? undefined : options.env[reviewKeyEnv]?.trim();
  if (reviewKeyEnv !== undefined && !approvalApiKey) {
    throw new AgentError('CONFIG_ERROR', `缺少审批凭据：请设置环境变量 ${reviewKeyEnv}。`);
  }
  const mcpHeaders: Record<string, Record<string, string>> = Object.create(null);
  for (const server of config.mcp?.servers ?? []) {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, reference] of Object.entries(server.headers)) {
      const value = options.env[reference.env];
      if (!value?.trim() || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new AgentError('CONFIG_ERROR', `MCP 请求头环境变量缺失或无效：${reference.env}。`);
      }
      headers[name] = value;
    }
    mcpHeaders[server.name] = headers;
  }
  return { ...config, workspace, apiKey, mcpHeaders, ...(approvalApiKey === undefined ? {} : { approvalApiKey }) };
}

export async function restoreSessionConfig(config: ModelConfig, env: NodeJS.ProcessEnv): Promise<ResolvedConfig> {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new AgentError('PROVIDER_ERROR', '会话运行配置无效，无法恢复。');
  const workspacePath = parsed.data.workspace;
  let workspace: string;
  try {
    workspace = await realpath(workspacePath);
    if (!(await stat(workspace)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new AgentError('CONFIG_ERROR', `会话工作区不可用：${workspacePath}。`);
  }
  const apiKey = env[parsed.data.apiKeyEnv]?.trim();
  if (!apiKey) throw new AgentError('CONFIG_ERROR', `缺少凭据：请在环境变量或 .env 中设置 ${parsed.data.apiKeyEnv}。`);
  const reviewKeyEnv = parsed.data.approval.model?.apiKeyEnv;
  const approvalApiKey = reviewKeyEnv === undefined ? undefined : env[reviewKeyEnv]?.trim();
  if (reviewKeyEnv !== undefined && !approvalApiKey) {
    throw new AgentError('CONFIG_ERROR', `缺少审批凭据：请设置环境变量 ${reviewKeyEnv}。`);
  }
  const mcpHeaders: Record<string, Record<string, string>> = Object.create(null);
  for (const server of parsed.data.mcp?.servers ?? []) {
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
  return {
    ...parsed.data,
    workspace,
    apiKey,
    mcpHeaders,
    ...(approvalApiKey === undefined ? {} : { approvalApiKey }),
  };
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loggableConfig(config: ResolvedConfig): Omit<ModelConfig, 'approval'> {
  // Allow-list rather than removing a secret from an arbitrary object.
  return {
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    baseURL: config.baseURL ?? 'https://api.openai.com/v1',
    workspace: config.workspace,
    timeoutMs: config.timeoutMs,
    maxSteps: config.maxSteps,
  };
}
