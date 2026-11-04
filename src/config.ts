import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AgentError } from './errors.js';

const baseURLSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash;
}, 'baseURL 必须为 HTTP(S) 地址，且不能包含凭据、查询参数或片段');

export const configSchema = z.strictObject({
  provider: z.literal('openai').default('openai'),
  model: z.string().trim().min(1).default('gpt-4.1-mini-2025-04-14'),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('OPENAI_API_KEY'),
  baseURL: baseURLSchema.optional(),
  workspace: z.string().trim().min(1).default('./demo'),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(60_000),
  maxSteps: z.number().int().min(1).max(100).default(20),
});

export type ModelConfig = z.infer<typeof configSchema>;
export type ResolvedConfig = ModelConfig & { apiKey: string };

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
  return { ...config, workspace, apiKey };
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loggableConfig(config: ResolvedConfig): ModelConfig {
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
