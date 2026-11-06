import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { startLocalMCP } from './helpers/local-mcp-fixture.js';

let cwd = '';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
const call = (id: string, name: string, input: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(input) } });
async function mcp(sse = false) {
  const fixture = await startLocalMCP({ sse });
  cleanup.push(fixture.close);
  return fixture;
}
async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0], review?: Parameters<typeof startLocalOpenAIModel>[1], extra = {}) {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-mcp-'));
  const model = await startLocalOpenAIModel(respond, review);
  cleanup.push(model.close);
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL, workspace: '.', timeoutMs: 4000, ...extra,
  }));
  return model;
}
function run(input = '执行远程工具\n/exit\n', onOutput?: (stdout: string) => void) {
  return startCLI({
    cwd, conversationId: 'mcp', input,
    env: { TEST_MODEL_API_KEY: 'fake-model', QA_MCP_HEADER: 'fake-mcp-header-marker' },
  }, onOutput);
}
function results(model: Awaited<ReturnType<typeof setup>>) {
  return model.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
}

it('发现同名远端工具，独立审批后通过真实协议调用；凭据只进入连接器请求头', async () => {
  const a = await mcp(), b = await mcp(true);
  const model = await setup((_request, index) => index === 1 ? { calls: [
    call('a', 'mcp_alpha_echo', { text: '第一条' }),
    call('b', 'mcp_beta_echo', { text: '第二条' }),
    call('local', 'runtimeInfo', {}),
  ] } : { content: '远程调用完成' }, undefined, {
    mcp: { servers: [
      { name: 'alpha', url: a.url, headers: { Authorization: { env: 'QA_MCP_HEADER' } } },
      { name: 'beta', url: b.url },
    ] },
  });
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(model.requests[0]!.tools.map(({ function: f }) => f.name)).toEqual(expect.arrayContaining(['mcp_alpha_echo', 'mcp_beta_echo', 'runtimeInfo', 'Bash']));
  expect(a.calls).toEqual([{ name: 'echo', arguments: { text: '第一条' } }]);
  expect(b.calls).toEqual([{ name: 'echo', arguments: { text: '第二条' } }]);
  expect(model.approvalRequests.map((request) => JSON.parse(request.messages[1]!.content))).toEqual([
    { toolName: 'mcp_alpha_echo', input: { text: '第一条' } }, { toolName: 'mcp_beta_echo', input: { text: '第二条' } },
  ]);
  expect(results(model).map(({ tool_call_id }) => tool_call_id)).toEqual(['a', 'b', 'local']);
  expect(JSON.parse(results(model)[0]!.content)).toMatchObject({ is_error: false, output: { content: [{ type: 'text', text: '远端收到：第一条' }] } });
  expect(a.requests.every(({ headers }) => headers.authorization === 'fake-mcp-header-marker')).toBe(true);
  const history = await readFile(join(cwd, '.agent/conversations/mcp.json'), 'utf8');
  expect(JSON.stringify(model.requests) + JSON.stringify(model.approvalRequests) + history + result.stdout + result.stderr).not.toContain('fake-mcp-header-marker');
  expect(result.stdout).toContain('mcp_alpha_echo：成功');
});

it('等待及明确拒绝期间不调用远端；拒绝后继续同批顺序执行', async () => {
  const remote = await mcp();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = await setup((_request, index) => index === 1 ? { calls: [
    call('denied', 'mcp_alpha_echo', { text: '拒绝操作' }),
    call('approved', 'mcp_alpha_echo', { text: '批准操作' }),
    call('tail', 'runtimeInfo', {}),
  ] } : { content: '处理完成' }, async (_request, index) => {
    if (index === 1) { entered(); await gate; return { content: 'deny' }; }
    return { content: 'approve' };
  }, { mcp: { servers: [{ name: 'alpha', url: remote.url }] } });
  let live = '';
  const running = run(undefined, (output) => { live = output; });
  await Promise.race([waiting, running.done]);
  try {
    expect(model.approvalRequests).toHaveLength(1);
    expect(remote.calls).toEqual([]);
    expect(remote.requests.some(({ method }) => method === 'tools/list')).toBe(true);
    expect(live).not.toContain('mcp_alpha_echo：开始');
  } finally { release(); }
  const result = await running.done;
  expect(remote.calls).toEqual([{ name: 'echo', arguments: { text: '批准操作' } }]);
  expect(results(model).map(({ tool_call_id }) => tool_call_id)).toEqual(['denied', 'approved', 'tail']);
  expect(JSON.parse(results(model)[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(result.stdout.match(/mcp_alpha_echo：开始/g)).toHaveLength(1);
  expect(result.stdout.match(/mcp_alpha_echo：拒绝/g)).toHaveLength(1);
});

it('参数错误先拒绝、固定拒绝优先；固定允许及远端普通失败复用统一结果和事件', async () => {
  const remote = await mcp();
  remote.setTools([
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 2 } }, required: ['text'], additionalProperties: false } },
    { name: 'blocked', description: 'blocked', inputSchema: { type: 'object', properties: {} } },
  ]);
  const model = await setup((_request, index) => index === 1 ? { calls: [
    call('wrong-type', 'mcp_alpha_echo', { text: 42 }),
    call('missing', 'mcp_alpha_echo', {}),
    call('extra', 'mcp_alpha_echo', { text: 'hello', env: 'unauthorized' }),
    call('short', 'mcp_alpha_echo', { text: 'a' }),
    { id: 'json', type: 'function', function: { name: 'mcp_alpha_echo', arguments: '{invalid' } },
    call('unknown', 'mcp_alpha_missing', {}),
    call('denied', 'mcp_alpha_blocked', {}),
    call('failed', 'mcp_alpha_echo', { text: 'fail' }),
    call('ok', 'mcp_alpha_echo', { text: 'success' }),
    call('local', 'runtimeInfo', {}),
  ] } : { content: '完成' }, () => { throw new Error('固定策略不应审查'); }, {
    mcp: { servers: [{ name: 'alpha', url: remote.url }] },
    approval: { rules: [
      { toolName: 'mcp_alpha_echo', action: 'allow' },
      { toolName: 'mcp_alpha_blocked', action: 'allow' },
      { toolName: 'mcp_alpha_blocked', action: 'deny' },
    ] },
  });
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(model.approvalRequests).toEqual([]);
  expect(remote.calls).toEqual([{ name: 'echo', arguments: { text: 'fail' } }, { name: 'echo', arguments: { text: 'success' } }]);
  expect(results(model).map(({ tool_call_id }) => tool_call_id)).toEqual(['wrong-type', 'missing', 'extra', 'short', 'json', 'unknown', 'denied', 'failed', 'ok', 'local']);
  expect(results(model).map(({ content }) => JSON.parse(content).error?.code ?? 'success')).toEqual([
    'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ARGUMENTS',
    'UNKNOWN_TOOL', 'PERMISSION_DENIED', 'TOOL_EXECUTION_ERROR', 'success', 'success',
  ]);
  expect(result.stdout.match(/mcp_alpha_echo：开始/g)).toHaveLength(2);
  expect(result.stdout.match(/mcp_alpha_echo：失败/g)).toHaveLength(1);
  expect(result.stdout.match(/mcp_alpha_echo：成功/g)).toHaveLength(1);
  expect(result.stdout + result.stderr).not.toContain('远端声明失败');
});

it('远端 JSON Schema 2020-12 在公布和执行时保持同一份约束', async () => {
  const remote = await mcp();
  remote.setTools([{ name: 'echo', description: '2020 schema', inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {},
    $defs: { text: { type: 'string', enum: ['approved'] } },
    allOf: [{ properties: { text: { $ref: '#/$defs/text' } }, required: ['text'] }],
    unevaluatedProperties: false,
  } }]);
  const model = await setup((_request, index) => index === 1 ? { calls: [
    call('invalid', 'mcp_alpha_echo', { text: 'approved', extra: true }),
    call('valid', 'mcp_alpha_echo', { text: 'approved' }),
  ] } : { content: '完成' }, undefined, { mcp: { servers: [{ name: 'alpha', url: remote.url }] } });
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(model.requests[0]?.tools.find(({ function: f }) => f.name === 'mcp_alpha_echo')?.function.parameters).toMatchObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema', unevaluatedProperties: false,
  });
  expect(model.approvalRequests).toHaveLength(1);
  expect(remote.calls).toEqual([{ name: 'echo', arguments: { text: 'approved' } }]);
  expect(JSON.parse(results(model)[0]!.content).error.code).toBe('INVALID_TOOL_ARGUMENTS');
});

it('同轮固定名称、描述和 schema；下一轮重新连接发现最新定义', async () => {
  const remote = await mcp();
  remote.setTools([{ name: 'echo', description: '第一版', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]);
  const model = await setup((_request, index) => {
    if (index === 1) return { calls: [call('first', 'mcp_alpha_echo', { text: '旧定义调用1' })] };
    if (index === 2) return { calls: [call('second', 'mcp_alpha_echo', { text: '旧定义调用2' })] };
    if (index === 4) return { calls: [call('new', 'mcp_alpha_echo', { value: '新定义调用' }), call('new-tool', 'mcp_alpha_runtimeInfo', {})] };
    return { content: '完成' };
  }, () => {
    remote.setTools([
      { name: 'echo', description: '第二版', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
      { name: 'runtimeInfo', description: '远端同名工具', inputSchema: { type: 'object', properties: {} } },
    ]);
    return { content: 'approve' };
  }, { mcp: { servers: [{ name: 'alpha', url: remote.url }] } });
  const result = await run('第一轮\n第二轮\n/exit\n').done;
  expect(result.code).toBe(0);
  expect(remote.calls).toEqual([
    { name: 'echo', arguments: { text: '旧定义调用1' } }, { name: 'echo', arguments: { text: '旧定义调用2' } },
    { name: 'echo', arguments: { value: '新定义调用' } }, { name: 'runtimeInfo', arguments: {} },
  ]);
  expect(remote.requests.filter(({ method }) => method === 'tools/list')).toHaveLength(2);
  expect(remote.requests.filter(({ method }) => method === 'initialize')).toHaveLength(2);
  const old = model.requests[0]!.tools.find(({ function: f }) => f.name === 'mcp_alpha_echo')!;
  expect(old.function).toMatchObject({ description: '第一版', parameters: { required: ['text'] } });
  for (const request of model.requests.slice(1, 3)) {
    expect(request.tools.find(({ function: f }) => f.name === 'mcp_alpha_echo')).toEqual(old);
    expect(request.tools.some(({ function: f }) => f.name === 'mcp_alpha_runtimeInfo')).toBe(false);
  }
  expect(model.requests[3]!.tools.find(({ function: f }) => f.name === 'mcp_alpha_echo')?.function).toMatchObject({ description: '第二版', parameters: { required: ['value'] } });
  expect(model.requests[3]!.tools.map(({ function: f }) => f.name)).toEqual(expect.arrayContaining(['runtimeInfo', 'mcp_alpha_runtimeInfo']));
  expect(model.approvalRequests.map((request) => JSON.parse(request.messages[1]!.content).input)).toEqual([
    { text: '旧定义调用1' }, { text: '旧定义调用2' }, { value: '新定义调用' }, {},
  ]);
});

it.each([
  { servers: [{ name: 'invalid_name', url: 'http://127.0.0.1/mcp' }] },
  { servers: [{ name: 'alpha', url: 'ftp://example.com/mcp' }] },
  { servers: [{ name: 'alpha', url: 'https://user:plaintext-marker@example.com/mcp' }] },
  { servers: [{ name: 'alpha', url: 'https://example.com/mcp?key=plaintext-marker' }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', token: 'plaintext-marker' }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { Authorization: 'plaintext-marker' } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { Authorization: { env: 'invalid-name' } } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { Authorization: { env: 'UNSET_MCP_FAKE_ENV_42' } } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { 'bad header': { env: 'QA_MCP_HEADER' } } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { Host: { env: 'QA_MCP_HEADER' } } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp', headers: { Authorization: { env: 'QA_MCP_HEADER' }, authorization: { env: 'QA_MCP_HEADER' } } }] },
  { servers: [{ name: 'alpha', url: 'http://127.0.0.1/mcp' }, { name: 'alpha', url: 'http://127.0.0.1/mcp' }] },
  { servers: [], connectTimeoutMs: 0 }, { servers: [], discoveryTimeoutMs: '100' }, { servers: [], callTimeoutMs: 3_600_001 },
  { servers: [], extra: true },
])('非法 MCP 配置在请求及工具操作之前拒绝：%j', async (mcpConfig) => {
  const model = await setup(() => ({ content: '不应请求' }), undefined, { mcp: mcpConfig });
  const result = await run().done;
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('CONFIG_ERROR');
  expect(model.requests).toEqual([]);
  expect(result.stdout + result.stderr).not.toContain('plaintext-marker');
});

it('同一服务重复公布工具名称时明确报错，不能静默覆盖或启动主模型', async () => {
  const remote = await mcp();
  const definition = { name: 'echo', description: '重复', inputSchema: { type: 'object' as const, properties: {} } };
  remote.setTools([definition, definition]);
  const model = await setup(() => ({ content: '不应请求' }), undefined, { mcp: { servers: [{ name: 'alpha', url: remote.url }] } });
  const result = await run().done;
  expect(result.stdout + result.stderr).toContain('MCP 工具名称冲突');
  expect(model.requests).toEqual([]);
  expect(remote.calls).toEqual([]);
});

it('人工模式的非交互拒绝沿用同一路径，远端调用为零', async () => {
  const remote = await mcp();
  const model = await setup((_request, index) => index === 1 ? { calls: [call('denied', 'mcp_alpha_echo', { text: '不能执行' })] } : { content: '已拒绝' }, undefined, {
    mcp: { servers: [{ name: 'alpha', url: remote.url }] }, approval: { mode: 'human' },
  });
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(remote.calls).toEqual([]);
  expect(model.approvalRequests).toEqual([]);
  expect(JSON.parse(results(model)[0]!.content).error.code).toBe('PERMISSION_DENIED');
  expect(result.stdout).not.toContain('mcp_alpha_echo：开始');
});

it('一个服务连接失败不影响健康服务及内置工具，不输出原始异常或认证头', async () => {
  const remote = await mcp();
  const model = await setup((_request, index) => index === 1 ? { calls: [
    call('healthy', 'mcp_alpha_echo', { text: 'healthy' }), call('local', 'runtimeInfo', {}),
  ] } : { content: '完成' }, undefined, { mcp: { servers: [
    { name: 'offline', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: { env: 'QA_MCP_HEADER' } } },
    { name: 'alpha', url: remote.url },
  ] } });
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('MCP 服务 offline 连接或工具发现失败，本轮不可用');
  expect(remote.calls).toEqual([{ name: 'echo', arguments: { text: 'healthy' } }]);
  expect(results(model).map(({ tool_call_id }) => tool_call_id)).toEqual(['healthy', 'local']);
  expect(result.stdout + result.stderr).not.toMatch(/fake-mcp-header-marker|TypeError|fetch failed|MCPClientError/);
});

it.each(['initialize', 'tools/list', 'tools/call'] as const)('基础独立上限约束 %s 等待，其他工具仍可用', async (phase) => {
  const remote = await startLocalMCP({ hang: phase });
  cleanup.push(remote.close);
  const model = await setup((_request, index) => phase === 'tools/call' && index === 1 ? { calls: [
    call('remote', 'mcp_alpha_echo', { text: '挂起' }), call('local', 'runtimeInfo', {}),
  ] } : { content: '完成' }, undefined, { mcp: {
    servers: [{ name: 'alpha', url: remote.url }], connectTimeoutMs: 120, discoveryTimeoutMs: 120, callTimeoutMs: 120,
  } });
  const result = await run().done;
  expect(remote.requests.some(({ method }) => method === phase)).toBe(true);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('完成');
  expect(result.stderr).not.toContain('"errorCode":"TIMEOUT"');
  if (phase === 'tools/call') {
    expect(results(model).map(({ tool_call_id }) => tool_call_id)).toEqual(['remote', 'local']);
    expect(JSON.parse(results(model)[0]!.content).error.code).toBe('TOOL_EXECUTION_ERROR');
  } else {
    expect(result.stderr).toContain('本轮不可用');
    expect(model.requests[0]!.tools.some(({ function: f }) => f.name === 'runtimeInfo')).toBe(true);
    expect(model.requests[0]!.tools.some(({ function: f }) => f.name === 'mcp_alpha_echo')).toBe(false);
  }
});

it.each(['deadline', 'SIGINT'] as const)('发现期间遵守公共 %s 停止入口，不请求主模型或后续服务', async (stop) => {
  const remote = await startLocalMCP({ hang: 'tools/list' });
  cleanup.push(remote.close);
  const later = await mcp();
  const model = await setup(() => ({ content: '不应请求' }), undefined, {
    timeoutMs: stop === 'deadline' ? 1000 : 4000,
    mcp: { servers: [{ name: 'alpha', url: remote.url }, { name: 'later', url: later.url }], discoveryTimeoutMs: 5000 },
  });
  const running = run();
  if (stop === 'SIGINT') {
    await expect.poll(() => remote.requests.some(({ method }) => method === 'tools/list')).toBe(true);
    running.child.kill('SIGINT');
  }
  const result = await running.done;
  expect(result.code).toBe(stop === 'deadline' ? 0 : 130);
  expect(result.stderr).toContain(stop === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
  expect(model.requests).toEqual([]);
  expect(model.approvalRequests).toEqual([]);
  expect(later.requests).toEqual([]);
  await expect(readFile(join(cwd, '.agent/conversations/mcp.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
