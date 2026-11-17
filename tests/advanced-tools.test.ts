import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { DEFAULT_SANDBOX, type ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest } from './helpers/local-openai-fixture.js';
import { tempDir } from './helpers/temp-dir.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runWithCalls(
  options: { workspace: string; fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>; config?: Partial<ResolvedConfig> },
) {
  const config: ResolvedConfig = {
    approval: { mode: 'auto', timeoutMs: 30_000 },
    permissions: { allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX },
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    baseURL: options.fixture.baseURL, workspace: options.workspace, timeoutMs: 5000, maxSteps: 8,
    ...options.config,
  };
  await runAgent(config, '执行工具', {
    smokeTool: false,
    onToolEvent: () => undefined,
  });
  // 工具结果会随历史出现在后续主模型请求中；按调用 ID 取最后一次记录。
  const results = new Map<string, string>();
  for (const request of options.fixture.requests) {
    for (const message of request.messages) {
      if (message.role !== 'tool') continue;
      const toolMessage = message as unknown as { tool_call_id: string; content: string };
      results.set(toolMessage.tool_call_id, toolMessage.content);
    }
  }
  return {
    config,
    output: (id: string) => {
      const content = results.get(id);
      if (content === undefined) throw new Error(`缺少工具结果：${id}`);
      return JSON.parse(content) as Record<string, unknown>;
    },
    tools: options.fixture.requests[0]!.tools.map(({ function: definition }) => definition.name),
  };
}

it('公布 Claude Code 风格的九种工具，并可按参数完成读写编辑', async () => {
  const workspace = await tempDir('qhy-advanced-files-');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'write', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'note.txt', content: 'alpha\nbeta\nalpha' }) } },
    { id: 'read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'note.txt' }) } },
    { id: 'edit', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'note.txt', old_string: 'beta', new_string: 'BETA' }) } },
  ] } : { content: '文件工具完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output, tools } = await runWithCalls({ workspace, fixture });
  expect(tools).toEqual(expect.arrayContaining([
    'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch',
  ]));
  expect(output('write')).toMatchObject({ is_error: false, output: { success: true } });
  expect(output('read')).toMatchObject({ is_error: false, output: { content: 'alpha\nbeta\nalpha' } });
  expect(output('edit')).toMatchObject({ is_error: false, output: { success: true, replacements: 1 } });
  await expect(readFile(join(workspace, 'note.txt'), 'utf8')).resolves.toBe('alpha\nBETA\nalpha');
});

it('Read 支持 offset 与 limit，Write 可重写未预读的既有文件', async () => {
  const workspace = await tempDir('qhy-advanced-read-');
  await writeFile(join(workspace, 'lines.txt'), 'one\ntwo\nthree\nfour\nfive');
  await writeFile(join(workspace, 'rewrite.txt'), '旧内容');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'slice', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'lines.txt', offset: 2, limit: 2 }) } },
    { id: 'rewrite', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'rewrite.txt', content: '新内容' }) } },
  ] } : { content: '读取完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  expect(output('slice')).toMatchObject({ is_error: false, output: {
    content: 'two\nthree', startLine: 2, numLines: 2, totalLines: 5, truncated: true,
  } });
  expect(output('rewrite')).toMatchObject({ is_error: false, output: { success: true } });
  await expect(readFile(join(workspace, 'rewrite.txt'), 'utf8')).resolves.toBe('新内容');
});

it('Edit 默认要求唯一匹配，失败时不修改文件；replace_all 替换全部匹配', async () => {
  const workspace = await tempDir('qhy-advanced-edit-');
  await writeFile(join(workspace, 'edit.txt'), 'a x a x');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'preread', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'edit.txt' }) } },
    { id: 'multiple', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'edit.txt', old_string: 'x', new_string: 'y' }) } },
    { id: 'missing', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'edit.txt', old_string: 'zzz', new_string: 'y' }) } },
    { id: 'same', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'edit.txt', old_string: 'a', new_string: 'a' }) } },
    { id: 'all', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'edit.txt', old_string: 'a', new_string: 'b', replace_all: true }) } },
  ] } : { content: '编辑完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  expect(output('preread')).toMatchObject({ is_error: false, output: { content: 'a x a x' } });
  for (const id of ['multiple', 'missing', 'same']) {
    expect(output(id)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  }
  expect(output('all')).toMatchObject({ is_error: false, output: { success: true, replacements: 2 } });
  await expect(readFile(join(workspace, 'edit.txt'), 'utf8')).resolves.toBe('b x b x');
});

it('Edit 要求先读取既有文件，读取后才允许替换', async () => {
  const workspace = await tempDir('qhy-advanced-edit-baseline-');
  await writeFile(join(workspace, 'baseline.txt'), '旧文本');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'unread', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'baseline.txt', old_string: '旧', new_string: '新' }) } },
  ] } : index === 2 ? { calls: [
    { id: 'read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'baseline.txt' }) } },
  ] } : index === 3 ? { calls: [
    { id: 'after-read', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'baseline.txt', old_string: '旧', new_string: '新' }) } },
  ] } : { content: '基线完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  expect(output('unread')).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  expect(String((output('unread').error as { message: string }).message)).toMatch(/尚未读取/u);
  expect(output('read')).toMatchObject({ is_error: false, output: { content: '旧文本' } });
  expect(output('after-read')).toMatchObject({ is_error: false, output: { success: true, replacements: 1 } });
  await expect(readFile(join(workspace, 'baseline.txt'), 'utf8')).resolves.toBe('新文本');
});

it('TodoWrite 以完整列表替换待办状态且无需审批', async () => {
  const workspace = await tempDir('qhy-advanced-todo-');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'first', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [
      { content: '分析', status: 'completed', activeForm: '分析中' },
      { content: '实现', status: 'in_progress', activeForm: '实现中' },
      { content: '测试', status: 'pending', activeForm: '测试中' },
    ] }) } },
  ] } : index === 2 ? { calls: [
    { id: 'second', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [
      { content: '测试', status: 'in_progress', activeForm: '测试中' },
    ] }) } },
  ] } : { content: '待办已更新' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  expect(output('first')).toMatchObject({ is_error: false, output: { count: 3 } });
  expect(output('second')).toMatchObject({ is_error: false, output: { count: 1, todos: [
    { content: '测试', status: 'in_progress', activeForm: '测试中' },
  ] } });
  expect(fixture.approvalRequests).toHaveLength(0);
});

it('WebFetch 拒绝本机、内网与云 metadata 地址且不发出请求，其他调用继续', async () => {
  const workspace = await tempDir('qhy-advanced-webfetch-');
  await writeFile(join(workspace, 'local.txt'), '本地内容');
  let reached = 0;
  const server: Server = createServer((_request, response) => { reached += 1; response.end('不应读取'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未绑定端口');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'loopback', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, prompt: '提取内容' }) } },
    { id: 'metadata', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/', prompt: '提取内容' }) } },
    { id: 'localhost', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: `http://localhost:${address.port}/`, prompt: '提取内容' }) } },
    { id: 'scheme', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'file:///etc/passwd', prompt: '提取内容' }) } },
    { id: 'credentials', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'http://user:pass@example.com/', prompt: '提取内容' }) } },
    { id: 'invalid', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'not-a-url', prompt: '提取内容' }) } },
    { id: 'still-read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'local.txt' }) } },
  ] } : { content: '网络边界完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  for (const id of ['loopback', 'metadata', 'localhost']) {
    expect(output(id)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(String((output(id).error as { message: string }).message)).toMatch(/本机|内网|metadata|公开/iu);
  }
  expect(String((output('scheme').error as { message: string }).message)).toMatch(/HTTP\/HTTPS/u);
  expect(String((output('credentials').error as { message: string }).message)).toMatch(/用户名或密码/u);
  expect(String((output('invalid').error as { message: string }).message)).toMatch(/地址无效/u);
  expect(reached).toBe(0);
  expect(output('still-read')).toMatchObject({ is_error: false, output: { content: '本地内容' } });
});

it('WebSearch 未配置 Tavily Key 时返回明确错误，其他工具不受影响', async () => {
  const workspace = await tempDir('qhy-advanced-websearch-missing-');
  await writeFile(join(workspace, 'keep.txt'), '保留内容');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'search', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: '今日新闻' }) } },
    { id: 'keep', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'keep.txt' }) } },
  ] } : { content: '搜索边界完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  expect(output('search')).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  expect(String((output('search').error as { message: string }).message)).toMatch(/Tavily|TAVILY_API_KEY/u);
  expect(output('keep')).toMatchObject({ is_error: false, output: { content: '保留内容' } });
});

it('WebSearch 对额度耗尽、鉴权失败与响应无效返回可区分错误，其他工具继续', async () => {
  const workspace = await tempDir('qhy-advanced-websearch-errors-');
  await writeFile(join(workspace, 'keep.txt'), '保留内容');
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const query = (JSON.parse(Buffer.concat(chunks).toString()) as { query: string }).query;
    if (query === 'quota') {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'rate limit' }));
      return;
    }
    if (query === 'auth') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'invalid key' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('not-json');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未绑定端口');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'quota', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'quota' }) } },
    { id: 'auth', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'auth' }) } },
    { id: 'invalid', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'invalid' }) } },
    { id: 'keep', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'keep.txt' }) } },
  ] } : { content: '搜索错误完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({
    workspace, fixture,
    config: {
      webSearch: { provider: 'tavily', apiKeyEnv: 'TEST_TAVILY_KEY', baseURL: `http://127.0.0.1:${address.port}`, timeoutMs: 5000, maxResults: 5 },
      webSearchApiKey: 'test-tavily-key',
    },
  });
  for (const id of ['quota', 'auth', 'invalid']) {
    expect(output(id)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  }
  expect(String((output('quota').error as { message: string }).message)).toMatch(/额度|受限/u);
  expect(String((output('auth').error as { message: string }).message)).toMatch(/API Key|权限/u);
  expect(String((output('invalid').error as { message: string }).message)).toMatch(/响应/u);
  expect(output('keep')).toMatchObject({ is_error: false, output: { content: '保留内容' } });
});

it('WebSearch 通过 Tavily 兼容接口返回搜索结果，并可按搜索服务扩展配置', async () => {
  const workspace = await tempDir('qhy-advanced-websearch-');
  const requests: Array<Record<string, unknown>> = [];
  const authorizations: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    authorizations.push(String(request.headers.authorization));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    // Tavily 在 include_answer=false 时返回 answer: null，解析仍应成功。
    response.end(JSON.stringify({ results: [
      { title: '结果一', url: 'https://example.com/one', content: '摘要一', score: 0.9 },
      { title: '结果二', url: 'https://example.com/two', content: '摘要二', score: 0.8 },
    ], answer: null }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未绑定端口');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'tavily', type: 'function', function: { name: 'WebSearch', arguments: JSON.stringify({ query: '类型脚本', max_results: 2 }) } },
  ] } : { content: '搜索完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output, config } = await runWithCalls({
    workspace, fixture,
    config: {
      webSearch: { provider: 'tavily', apiKeyEnv: 'TEST_TAVILY_KEY', baseURL: `http://127.0.0.1:${address.port}`, timeoutMs: 5000, maxResults: 5 },
      webSearchApiKey: 'test-tavily-key',
    },
  });
  expect(config.webSearch?.provider).toBe('tavily');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ query: '类型脚本', max_results: 2 });
  expect(requests[0]).not.toHaveProperty('api_key');
  expect(authorizations).toEqual(['Bearer test-tavily-key']);
  expect(output('tavily')).toMatchObject({ is_error: false, output: { query: '类型脚本', results: [
    { title: '结果一', url: 'https://example.com/one', content: '摘要一', score: 0.9 },
    { title: '结果二', url: 'https://example.com/two', content: '摘要二', score: 0.8 },
  ] } });
  // null 摘要不应透传给模型，返回值中不出现 answer 字段。
  expect((output('tavily').output as Record<string, unknown>)).not.toHaveProperty('answer');
});

it('新工具沿用 Read、Write 与 WebFetch 权限规则，deny 优先且 allow 可免除审批', async () => {
  const workspace = await tempDir('qhy-advanced-permissions-');
  await writeFile(join(workspace, 'secret.txt'), '机密');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'read-secret', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'secret.txt' }) } },
    { id: 'read-open', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'open.txt' }) } },
    { id: 'edit-open', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'open.txt', old_string: 'old', new_string: 'new' }) } },
    { id: 'fetch-denied', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'https://example.com/public', prompt: '提取' }) } },
  ] } : { content: '权限验证完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'open.txt'), 'old');
  const { output } = await runWithCalls({
    workspace, fixture,
    config: {
      permissions: {
        allow: ['Read', 'Write'],
        ask: [],
        deny: ['Read(secret.txt)', 'WebFetch'],
        sandbox: DEFAULT_SANDBOX,
      },
    },
  });
  expect(output('read-secret')).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(output('read-open')).toMatchObject({ is_error: false, output: { content: 'old' } });
  expect(output('edit-open')).toMatchObject({ is_error: false, output: { success: true } });
  expect(output('fetch-denied')).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(fixture.approvalRequests).toHaveLength(0);
});

it('Edit 规则按路径分别允许或拒绝，与 Write 规则独立生效', async () => {
  const workspace = await tempDir('qhy-advanced-edit-rules-');
  await writeFile(join(workspace, 'locked.txt'), '旧');
  await writeFile(join(workspace, 'allowed.txt'), '旧');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'read-locked', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'locked.txt' }) } },
    { id: 'read-allowed', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'allowed.txt' }) } },
    { id: 'edit-locked', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'locked.txt', old_string: '旧', new_string: '新' }) } },
    { id: 'edit-allowed', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'allowed.txt', old_string: '旧', new_string: '新' }) } },
  ] } : { content: 'Edit 规则完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({
    workspace, fixture,
    config: {
      permissions: {
        allow: ['Read', 'Edit(allowed.txt)'],
        ask: [],
        deny: ['Edit(locked.txt)'],
        sandbox: DEFAULT_SANDBOX,
      },
    },
  });
  expect(output('read-locked')).toMatchObject({ is_error: false, output: { content: '旧' } });
  expect(output('read-allowed')).toMatchObject({ is_error: false, output: { content: '旧' } });
  expect(output('edit-locked')).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(output('edit-allowed')).toMatchObject({ is_error: false, output: { success: true, replacements: 1 } });
  expect(fixture.approvalRequests).toHaveLength(0);
  await expect(readFile(join(workspace, 'locked.txt'), 'utf8')).resolves.toBe('旧');
  await expect(readFile(join(workspace, 'allowed.txt'), 'utf8')).resolves.toBe('新');
});

it('新工具在参数无效时于审批前拒绝，TodoWrite 拒绝多个进行中任务', async () => {
  const workspace = await tempDir('qhy-advanced-invalid-');
  await writeFile(join(workspace, 'guard.txt'), 'original');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
    { id: 'edit-missing-old', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'guard.txt', new_string: 'x' }) } },
    { id: 'read-extra', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'guard.txt', extra: true }) } },
    { id: 'fetch-no-prompt', type: 'function', function: { name: 'WebFetch', arguments: JSON.stringify({ url: 'https://example.com/' }) } },
    { id: 'todo-multiple', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos: [
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
    ] }) } },
  ] } : { content: '参数边界完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { output } = await runWithCalls({ workspace, fixture });
  for (const id of ['edit-missing-old', 'read-extra', 'fetch-no-prompt']) {
    expect(output(id)).toMatchObject({ is_error: true, error: { code: 'INVALID_TOOL_ARGUMENTS' } });
  }
  expect(output('todo-multiple')).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  expect(fixture.approvalRequests).toHaveLength(0);
  await expect(readFile(join(workspace, 'guard.txt'), 'utf8')).resolves.toBe('original');
});

it('允许未见过的 WebFetch 规则参数不影响其他网络能力，工具定义包含 Claude 参数', async () => {
  const workspace = await tempDir('qhy-advanced-tools-params-');
  const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { content: '完成' } : { content: '完成' });
  cleanups.push(fixture.close, () => rm(workspace, { recursive: true, force: true }));
  const { config } = await runWithCalls({
    workspace, fixture,
    config: {
      permissions: {
        allow: ['WebFetch(domain:example.com)', 'WebSearch'],
        ask: [], deny: [], sandbox: DEFAULT_SANDBOX,
      },
    },
  });
  const request: FixtureRequest = fixture.requests[0]!;
  const definitions = Object.fromEntries(request.tools.map(({ function: definition }) => [definition.name, definition]));
  expect(config.permissions?.allow).toEqual(['WebFetch(domain:example.com)', 'WebSearch']);
  expect(definitions.Edit!.parameters).toMatchObject({ required: ['file_path', 'old_string', 'new_string'] });
  expect(definitions.Read!.parameters).toMatchObject({ required: ['file_path'] });
  expect(definitions.WebFetch!.parameters).toMatchObject({ required: ['url', 'prompt'] });
  expect(definitions.TodoWrite!.parameters).toMatchObject({ required: ['todos'] });
});
