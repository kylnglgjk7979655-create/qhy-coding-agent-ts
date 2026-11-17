import { z } from 'zod';
import type { ResolvedConfig } from '../../services/settings/config.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  signal?: AbortSignal;
}

/** 其他搜索服务实现该接口后，可在 registerWebSearchTool 中按配置选择。 */
export interface WebSearchProvider {
  readonly name: string;
  search(request: WebSearchRequest): Promise<{ results: WebSearchResult[]; answer?: string }>;
}

const tavilySearchResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number().optional(),
  })).default([]),
  answer: z.string().optional(),
});

class TavilyWebSearchProvider implements WebSearchProvider {
  readonly name = 'tavily';

  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async search(request: WebSearchRequest): Promise<{ results: WebSearchResult[]; answer?: string }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${this.baseURL.replace(/\/$/u, '')}/search`, {
        method: 'POST',
        // Tavily 现行文档使用 Bearer 鉴权；凭据只出现在请求头，不进入请求正文。
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          query: request.query,
          max_results: request.maxResults,
          search_depth: 'basic',
          include_answer: false,
          ...(request.includeDomains === undefined ? {} : { include_domains: request.includeDomains }),
          ...(request.excludeDomains === undefined ? {} : { exclude_domains: request.excludeDomains }),
        }),
        signal,
      });
    } catch {
      if (timeout.aborted) throw new Error('Tavily 搜索超时。');
      if (request.signal?.aborted) throw request.signal.reason ?? new Error('Tavily 搜索已取消。');
      throw new Error('Tavily 搜索服务不可达。');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw new Error('Tavily API Key 无效或权限不足。');
      if (response.status === 429) throw new Error('Tavily 额度耗尽或请求受限。');
      throw new Error(`Tavily 搜索服务失败（HTTP ${response.status}）。`);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error('Tavily 响应无效。'); }
    const parsed = tavilySearchResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Tavily 响应无法解析。');
    return {
      results: parsed.data.results.map(({ title, url, content, score }) => ({
        title, url, content, ...(score === undefined ? {} : { score }),
      })),
      ...(parsed.data.answer === undefined ? {} : { answer: parsed.data.answer }),
    };
  }
}

function createWebSearchProvider(config: ResolvedConfig, apiKey: string): WebSearchProvider {
  const settings = config.webSearch;
  if (settings?.provider === undefined || settings.provider === 'tavily') {
    return new TavilyWebSearchProvider(settings?.baseURL ?? 'https://api.tavily.com', apiKey, settings?.timeoutMs ?? 30_000);
  }
  throw new Error(`不支持的 WebSearch 服务：${String(settings.provider)}。`);
}

export function registerWebSearchTool(registry: ToolRegistry, { config }: BuiltInToolContext): void {
  registry.register({
    name: 'WebSearch',
    concurrency: 'parallel',
    description: '使用 Tavily 搜索网络。query 为搜索词，可选 allowed_domains、blocked_domains 与 max_results。凭据从配置的环境变量读取。',
    inputSchema: z.strictObject({
      query: z.string().trim().min(1),
      allowed_domains: z.array(z.string().trim().min(1)).max(20).optional(),
      blocked_domains: z.array(z.string().trim().min(1)).max(20).optional(),
      max_results: z.number().int().min(1).max(20).optional(),
    }),
    permission: { tool: 'webSearch' },
    execute: async ({ query, allowed_domains, blocked_domains, max_results }, execution) => {
      const envName = config.webSearch?.apiKeyEnv ?? 'TAVILY_API_KEY';
      // 凭据只在 loadConfig 时从注入的 env 读取，工具不再直接访问 process.env。
      const apiKey = config.webSearchApiKey;
      if (!apiKey) {
        throw new Error(`WebSearch 未配置 Tavily API Key：请设置环境变量 ${envName}。`);
      }
      const provider = createWebSearchProvider(config, apiKey);
      const result = await provider.search({
        query,
        maxResults: max_results ?? config.webSearch?.maxResults ?? 5,
        ...(allowed_domains === undefined ? {} : { includeDomains: allowed_domains }),
        ...(blocked_domains === undefined ? {} : { excludeDomains: blocked_domains }),
        ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
      });
      return { query, ...result };
    },
  });
}
