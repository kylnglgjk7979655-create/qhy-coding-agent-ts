import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { readStoredSession } from './helpers/session-store.js';
import { tempDir } from './helpers/temp-dir.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('配置网络搜索后，首次搜索轮次仍能正常保存并重新加载会话', async () => {
  const cwd = await tempDir('qhy-websearch-session-cwd-');
  const userDir = await tempDir('qhy-websearch-session-user-');
  cleanups.push(() => rm(cwd, { recursive: true, force: true }), () => rm(userDir, { recursive: true, force: true }));
  const tavily: Server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 只关心请求已到达，正文无需解析。 */ }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ results: [
      { title: '汇率结果', url: 'https://example.com/rate', content: '一美元约合七元人民币。', score: 0.9 },
    ] }));
  });
  await new Promise<void>((resolve, reject) => { tavily.once('error', reject); tavily.listen(0, '127.0.0.1', resolve); });
  const address = tavily.address();
  if (!address || typeof address === 'string') throw new Error('本地搜索服务未绑定端口');
  cleanups.push(async () => { tavily.closeAllConnections(); await new Promise<void>((resolve) => tavily.close(() => resolve())); });

  const model = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'search', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: '美元兑人民币的汇率' }) } },
  ] } : { content: '当前汇率约为七元人民币。' });
  cleanups.push(model.close);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 3000, maxSteps: 10,
    webSearch: { provider: 'tavily', baseURL: `http://127.0.0.1:${address.port}`, timeoutMs: 5000, maxResults: 5 },
    permissions: { allow: ['WebSearch'] },
  }));

  const child = startCLI({
    cwd, userDir,
    env: { TEST_MODEL_API_KEY: 'model-key', TAVILY_API_KEY: 'tavily-key' },
    input: '网络搜索 美元兑人民币的汇率\n/exit\n',
  });
  const result = await child.done;

  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('会话记录格式无效');
  expect(result.stdout).toContain('当前汇率约为七元人民币。');
  // 会话记录保留搜索配置，但不落盘搜索凭据值。
  const session = await readStoredSession(userDir);
  expect(session.config.webSearch).toMatchObject({ provider: 'tavily' });
  expect(JSON.stringify(session)).not.toContain('tavily-key');
});