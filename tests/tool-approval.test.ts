import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';

let cwd = '';
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}
async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0], review?: Parameters<typeof startLocalOpenAIModel>[1], extra = {}) {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-approval-'));
  const fixture = await startLocalOpenAIModel(respond, review);
  fixtures.push(fixture);
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
    model: 'main-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'TEST_APPROVAL_KEY',
    workspace: '.', timeoutMs: 3000, ...extra,
  }));
  return fixture;
}
function run(input = '私有用户目标\n/exit\n', onOutput?: (stdout: string) => void) {
  return startCLI({ cwd, conversationId: 'approval', input, env: { TEST_APPROVAL_KEY: 'fake-approval-secret' } }, onOutput);
}
function results(fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>) {
  return fixture.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
}

it('默认只读豁免，写入在独立审批通过之前无副作用或开始事件', async () => {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await setup((_request, index) => index === 1 ? { calls: [
    call('read', 'read_file', { path: 'note.txt' }), call('runtime', 'runtimeInfo', {}),
    call('write', 'write_file', { path: 'note.txt', content: 'approved-content' }),
  ] } : { content: '完成' }, async () => { entered(); await gate; return { content: 'approve' }; });
  await writeFile(join(cwd, 'note.txt'), 'before');
  let live = '';
  const running = run(undefined, (stdout) => { live = stdout; });
  // 旧实现直接完成，不发审查请求；竞速使缺失审批表现为明确断言失败。
  await Promise.race([waiting, running.done]);
  try {
    expect(fixture.approvalRequests).toHaveLength(1);
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('before');
    expect(live).not.toContain('write_file：开始');
    const review = fixture.approvalRequests[0]!;
    expect(review.model).toBe('main-fixture');
    expect(review.tools ?? []).toEqual([]);
    expect(review.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    expect(JSON.parse(review.messages[1]!.content)).toEqual({ toolName: 'write_file', input: { path: 'note.txt', content: 'approved-content' } });
    expect(JSON.stringify(review)).not.toContain('私有用户目标');
    expect(JSON.stringify(review)).not.toContain('before');
  } finally { release(); }
  const result = await running.done;
  expect(result.code).toBe(0);
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('approved-content');
  expect(results(fixture).map(({ tool_call_id }) => tool_call_id)).toEqual(['read', 'runtime', 'write']);
  expect(result.stdout + result.stderr).not.toContain('approved-content');
  expect(result.stdout + result.stderr).not.toContain('fake-approval-secret');
});

it.each([
  { rules: [{ toolName: 'write_file', action: 'allow' }], expected: false },
  { rules: [{ toolName: 'write_file', action: 'deny' }], expected: true },
  { rules: [{ toolName: 'write_file', action: 'allow' }, { toolName: 'write_file', action: 'ask' }, { toolName: 'write_file', action: 'deny' }], expected: true },
])('固定策略优先且拒绝胜出：$rules', async ({ rules, expected }) => {
  const fixture = await setup((_request, index) => index === 1 ? { calls: [
    call('write', 'write_file', { path: 'note.txt', content: 'after' }),
    call('read', 'read_file', { path: 'note.txt' }),
  ] } : { content: '处理完毕' }, () => { throw new Error('不应审查'); }, { approval: { rules } });
  await writeFile(join(cwd, 'note.txt'), 'before');
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(0);
  const messages = results(fixture);
  expect(messages.map(({ tool_call_id }) => tool_call_id)).toEqual(['write', 'read']);
  expect(JSON.parse(messages[0]!.content)).toMatchObject(expected
    ? { is_error: true, error: { code: 'PERMISSION_DENIED' } } : { is_error: false });
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe(expected ? 'before' : 'after');
  if (expected) expect(result.stdout).not.toContain('write_file：开始');
});

it('参数与未知工具先拒绝，逐次审批不复用授权，明确拒绝后仍继续同批调用', async () => {
  const fixture = await setup((_request, index) => index === 1 ? { calls: [
    call('invalid', 'write_file', { path: 'bad.txt', content: 'bad', extra: true }),
    call('unknown', 'nonexistent', {}),
    call('one', 'write_file', { path: 'note.txt', content: 'one' }),
    call('two', 'write_file', { path: 'note.txt', content: 'two' }),
    call('three', 'write_file', { path: 'note.txt', content: 'two' }),
    call('read', 'read_file', { path: 'note.txt' }),
  ] } : { content: '已完成' }, (_request, index) => ({ content: index === 1 ? 'approve' : 'deny' }));
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(3);
  expect(fixture.approvalRequests.map((request) => JSON.parse(request.messages[1]!.content).input.content)).toEqual(['one', 'two', 'two']);
  const messages = results(fixture);
  expect(messages.map(({ tool_call_id }) => tool_call_id)).toEqual(['invalid', 'unknown', 'one', 'two', 'three', 'read']);
  expect(messages.slice(0, 5).map(({ content }) => {
    const value = JSON.parse(content) as { error?: { code: string } };
    return value.error?.code ?? 'success';
  })).toEqual(['INVALID_TOOL_ARGUMENTS', 'UNKNOWN_TOOL', 'success', 'PERMISSION_DENIED', 'PERMISSION_DENIED']);
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('one');
  await expect(readFile(join(cwd, 'bad.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(messages[5]!.content)).toEqual({ is_error: false, output: { content: 'one' } });
});

it.each(['invalid', 'unavailable', 'timeout', 'tools'] as const)('审批故障 %s 停止后续操作，保留副作用与成功历史并允许下一条输入', async (failure) => {
  const fixture = await setup((request, index) => {
    const prompt = request.messages.at(-1)?.content;
    if (index === 1 || prompt === '恢复输入') return { content: '成功回答' };
    return { calls: [
      call('kept', 'write_file', { path: 'kept.txt', content: 'kept-private-content' }),
      call('blocked', 'write_file', { path: 'blocked.txt', content: 'blocked-private-content' }),
      call('later', 'write_file', { path: 'later.txt', content: 'later' }),
    ] };
  }, (_request, index) => {
    if (index === 1) return { content: 'approve' };
    if (failure === 'timeout') return undefined;
    if (failure === 'unavailable') return { status: 503, content: 'raw-private-exception' };
    if (failure === 'tools') return { calls: [call('review-write', 'write_file', { path: 'rogue.txt', content: 'rogue' })] };
    return { content: 'approve and execute everything raw-private-exception' };
  }, { approval: { timeoutMs: 150 } });
  await run('成功轮\n/exit\n').done;
  const path = join(cwd, '.agent/conversations/approval.json');
  const previous = await readFile(path, 'utf8');
  const result = await run('失败轮\n/exit\n').done;
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('审批');
  expect(result.stdout).toContain('停止本轮');
  expect(result.stderr).toContain('APPROVAL_ERROR');
  expect(result.stdout).not.toContain('[工具] write_file：失败');
  expect(result.stdout.split('write_file：开始')).toHaveLength(2);
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept-private-content');
  for (const file of ['blocked.txt', 'later.txt', 'rogue.txt']) {
    await expect(readFile(join(cwd, file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readFile(path, 'utf8')).toBe(previous);
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.approvalRequests).toHaveLength(2);
  expect(result.stdout + result.stderr).not.toMatch(/raw-private-exception|kept-private-content|blocked-private-content|fake-approval-secret/);
  const recovery = await run('失败轮\n恢复输入\n/exit\n').done;
  expect(recovery.stdout).toContain('成功回答');
  const saved = await readFile(path, 'utf8');
  expect(saved).not.toContain('失败轮');
  expect(saved).toContain('恢复输入');
  expect(fixture.requests.at(-1)!.messages.some(({ content }) => typeof content === 'string' && content.includes('失败轮'))).toBe(false);
});

it('独立审查模型只收到专用输入，ask 可覆盖只读默认豁免', async () => {
  const review = await startLocalOpenAIModel(() => { throw new Error('不应收到主请求'); }, () => ({ content: 'deny' }));
  fixtures.push(review);
  const fixture = await setup((_request, index) => index === 1 ? { calls: [call('read', 'read_file', { path: 'note.txt' })] } : { content: '拒绝读取' }, undefined, {
    approval: { rules: [{ toolName: 'read_file', action: 'ask' }], model: { model: 'review-fixture', baseURL: review.baseURL, apiKeyEnv: 'TEST_APPROVAL_KEY' } },
  });
  await writeFile(join(cwd, 'note.txt'), 'hidden-file-content');
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(0);
  expect(review.approvalRequests).toHaveLength(1);
  expect(review.approvalRequests[0]!.model).toBe('review-fixture');
  expect(JSON.stringify(review.approvalRequests)).not.toContain('hidden-file-content');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(result.stdout).not.toContain('read_file：开始');
});

it.each(['deadline', 'SIGINT', 'SIGTERM'] as const)('审批等待受到 %s 约束，停止后不启动当前或后续调用', async (stop) => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const fixture = await setup(() => ({ calls: [
    call('write', 'write_file', { path: 'blocked.txt', content: 'blocked' }),
    call('later', 'runtimeInfo', {}),
  ] }), () => { entered(); return undefined; }, { timeoutMs: stop === 'deadline' ? 250 : 3000, approval: { timeoutMs: 2000 } });
  const running = run();
  await Promise.race([waiting, running.done]);
  expect(fixture.approvalRequests).toHaveLength(1);
  if (stop !== 'deadline') running.child.kill(stop);
  const result = await running.done;
  expect(result.code).toBe(stop === 'deadline' ? 0 : 130);
  expect(result.stderr).toContain(stop === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
  expect(result.stdout).not.toContain('：开始');
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.approvalRequests).toHaveLength(1);
  await expect(readFile(join(cwd, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, '.agent/conversations/approval.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { mode: 'automatic' }, { extra: true }, { timeoutMs: 0 }, { timeoutMs: '100' }, { timeoutMs: 3_600_001 },
  { rules: [{ toolName: 'write_file', action: 'always' }] },
  { rules: [{ toolName: ' ', action: 'allow' }] },
  { rules: [{ toolName: 'write_file', action: 'allow', path: '.' }] },
  { model: { model: ' ' } }, { model: { model: 'review', apiKey: 'plaintext-test-marker' } },
  { model: { model: 'review', apiKeyEnv: 'invalid-name' } },
  { model: { model: 'review', apiKeyEnv: 'UNSET_FAKE_REVIEW_ENV_42' } },
  { model: { model: 'review', baseURL: 'https://user:plaintext-test-marker@example.com' } },
])('非法审批配置在请求前明确拒绝：%j', async (approval) => {
  const fixture = await setup(() => ({ content: '不应请求' }), undefined, { approval });
  const result = await run().done;
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('CONFIG_ERROR');
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.approvalRequests).toHaveLength(0);
  expect(result.stdout + result.stderr).not.toContain('plaintext-test-marker');
});
