export function codexAuthEnvironment(
  env: NodeJS.ProcessEnv,
  loginStatus: (childEnv: NodeJS.ProcessEnv) => string,
): Record<string, string> {
  const mode = env.CODEX_AUTH_MODE || 'chatgpt';
  if (mode === 'api-key') {
    if (!env.CODEX_API_KEY) throw new Error('API 模式需要 CODEX_API_KEY；订阅用户使用默认 chatgpt 模式。');
    return { CODEX_API_KEY: env.CODEX_API_KEY };
  }
  if (mode !== 'chatgpt') throw new Error('CODEX_AUTH_MODE 只支持 chatgpt 或 api-key。');

  // 显式清空继承的 API 凭据，避免订阅模式意外使用 API 计费。
  const credentials = { CODEX_API_KEY: '', OPENAI_API_KEY: '' };
  let status: string;
  try {
    status = loginStatus({ ...env, ...credentials });
  } catch {
    throw new Error('无法确认 Codex 订阅登录，请在运行机器执行 codex login，再运行 codex login status。');
  }
  if (!/logged in using chatgpt/i.test(status)) {
    throw new Error('Codex 当前不是 ChatGPT 订阅登录；请在运行机器执行 codex login。');
  }
  return credentials;
}

const DEFAULT_CODEX_MODEL = 'gpt-6-luna';

export function resolveCodexModel(
  env: NodeJS.ProcessEnv,
  listModels: (childEnv: NodeJS.ProcessEnv) => string,
): string {
  const configuredModel = env.CODEX_MODEL?.trim();
  if (configuredModel) return configuredModel;

  try {
    const output = listModels(env);
    const parsed = JSON.parse(output) as { models?: Array<{ slug?: unknown }> };
    const slug = parsed.models?.find((model) => typeof model.slug === 'string' && model.slug.trim())?.slug;
    if (typeof slug === 'string' && slug.trim()) return slug;
  } catch {
    // 忽略探测错误，回退到稳定默认模型。
  }
  return DEFAULT_CODEX_MODEL;
}
