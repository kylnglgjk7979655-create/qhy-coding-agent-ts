import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse, FixtureToolCall } from './helpers/local-openai-fixture.js';

const homes: string[] = [];
const workspaces: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Respond = (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>;
type Review = (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>;

async function setup(settings: Record<string, unknown>, respond?: Respond, review?: Review) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-pre-tool-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-pre-tool-home-')));
  workspaces.push(workspace);
  homes.push(home);
  const fixture = await startLocalOpenAIModel(respond ?? (() => ({ content: '已完成' })), review);
  fixtures.push(fixture);
  await mkdir(join(workspace, '.agent'), { recursive: true });
  await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
    model: 'hook-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'HOOK_TEST_KEY',
    timeoutMs: 3000,
    ...settings,
  }));
  return { workspace, home, fixture };
}

function run(options: {
  workspace: string;
  home: string;
  input?: string;
  args?: string[];
  conversationId?: string;
}) {
  return startCLI({
    cwd: options.workspace,
    userDir: options.home,
    input: options.input ?? '用户目标\n/exit\n',
    args: options.args ?? ['--trust-hooks'],
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }).done;
}

function commandHook(command: string) {
  return { type: 'command' as const, command };
}

function decisionHook(decision: 'allow' | 'ask' | 'deny', reason: string) {
  const payload = JSON.stringify({
    hookSpecificOutput: { permissionDecision: decision, permissionDecisionReason: reason },
  });
  return commandHook(`printf '%s' '${payload}'`);
}

function updateHook(updatedInput: unknown, decision?: { decision: 'allow' | 'ask' | 'deny'; reason: string }) {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      ...(decision === undefined
        ? {}
        : { permissionDecision: decision.decision, permissionDecisionReason: decision.reason }),
      updatedInput,
    },
  });
  return commandHook(`printf '%s' '${payload}'`);
}

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function results(fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>) {
  return fixture.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{
    tool_call_id: string;
    content: string;
  }>;
}

it('deny 返回 PERMISSION_DENIED、无副作用且同批后续调用继续；stdin 使用 prepare 后输入和调用标识', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [commandHook('sh ./pre-hook.sh')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('deny-write', 'write_file', { path: 'blocked.txt', content: 'should-not-write' }),
    call('read-after', 'read_file', { path: 'note.txt' }),
  ] } : { content: '已处理' });
  await writeFile(join(workspace, 'note.txt'), 'existing');
  await writeFile(join(workspace, 'pre-hook.sh'), [
    'cat > pre-input.json',
    "if grep -q 'blocked.txt' pre-input.json; then printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"策略拒绝写入\"}}'; fi",
  ].join('\n'));

  const result = await run({ workspace, home, conversationId: 'pre-tool-deny' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  // 权限结论在审批前短路：模型审批不应被请求。
  expect(fixture.approvalRequests).toHaveLength(0);
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['deny-write', 'read-after']);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: false, output: { content: 'existing' } });
  await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  const input = JSON.parse(await readFile(join(workspace, 'pre-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    session_id: 'pre-tool-deny',
    cwd: workspace,
    approval_mode: 'model',
    hook_event_name: 'PreToolUse',
    tool_name: 'write_file',
    tool_use_id: 'deny-write',
    tool_input: {
      path: 'blocked.txt',
      content: 'should-not-write',
      target: join(workspace, 'blocked.txt'),
    },
  });
  expect(typeof input.transcript_path).toBe('string');
});

it.each([
  { name: 'deny 优先于 ask 与 allow', order: ['allow', 'ask', 'deny'] as const, expected: 'deny' },
  { name: 'deny 在配置开头也优先', order: ['deny', 'allow', 'ask'] as const, expected: 'deny' },
  { name: 'ask 优先于 allow', order: ['allow', 'ask'] as const, expected: 'ask' },
  { name: 'ask 在配置开头也优先', order: ['ask', 'allow'] as const, expected: 'ask' },
])('多个 PreToolUse 结论按 deny > ask > allow 聚合且与顺序无关：$name', async ({ order, expected }) => {
  const reasons = { allow: '允许理由', ask: '需要审批', deny: '拒绝理由' } as const;
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: order.map((decision) => decisionHook(decision, reasons[decision])) }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('aggregated-write', 'write_file', { path: 'out.txt', content: '聚合结果' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: `pre-tool-${order.join('-')}` });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResult = JSON.parse(results(fixture)[0]!.content) as { is_error: boolean; error?: { code: string } };
  if (expected === 'deny') {
    expect(toolResult).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    expect(fixture.approvalRequests).toHaveLength(0);
    await expect(readFile(join(workspace, 'out.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  expect(toolResult.is_error).toBe(false);
  expect(fixture.approvalRequests).toHaveLength(1);
  const review = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as {
    context: { environment: { preToolUse?: { decision: string; reason?: string } } };
  };
  expect(review.context.environment.preToolUse).toEqual({ decision: 'ask', reason: '需要审批' });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('聚合结果');
});

it.each([
  { name: 'allow 不能绕过 deny 规则', permissions: { deny: ['Write'] }, expected: 'deny' as const },
  { name: 'allow 遇到 ask 规则仍触发审批', permissions: { ask: ['Write'] }, expected: 'ask' as const },
  { name: '没有 deny/ask 规则时 allow 跳过默认审批', permissions: {}, expected: 'allow' as const },
])('$name', async ({ permissions, expected }) => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    permissions,
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [decisionHook('allow', 'Hook 允许本次写入')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('allowed-write', 'write_file', { path: 'out.txt', content: '允许内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: `pre-tool-allow-${expected}` });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResult = JSON.parse(results(fixture)[0]!.content) as { is_error: boolean; error?: { code: string } };
  if (expected === 'deny') {
    expect(toolResult).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    expect(fixture.approvalRequests).toHaveLength(0);
    await expect(readFile(join(workspace, 'out.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  expect(toolResult.is_error).toBe(false);
  expect(fixture.approvalRequests).toHaveLength(expected === 'ask' ? 1 : 0);
  if (expected === 'ask') {
    const review = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as {
      context: { environment: { preToolUse?: { decision: string; reason?: string } } };
    };
    expect(review.context.environment.preToolUse).toEqual({ decision: 'allow', reason: 'Hook 允许本次写入' });
  }
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('允许内容');
});

it('ask 即使权限规则原本 allow 也强制审批，并把理由作为审批说明', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    permissions: { allow: ['Write'] },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [decisionHook('ask', '需要额外确认')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('ask-write', 'write_file', { path: 'out.txt', content: '需确认内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-ask' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(1);
  const payload = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as {
    toolName: string;
    context: { environment: { preToolUse?: { decision: string; reason?: string } } };
  };
  expect(payload.toolName).toBe('write_file');
  expect(payload.context.environment.preToolUse).toEqual({ decision: 'ask', reason: '需要额外确认' });
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('需确认内容');
});

it('Hook allow 不能跳过工作区外读取这类范围审批', async () => {
  const outsideDirectory = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-outside-')));
  workspaces.push(outsideDirectory);
  const outsidePath = join(outsideDirectory, 'outside.txt');
  await writeFile(outsidePath, '工作区外内容');
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'read_file', hooks: [decisionHook('allow', 'Hook 允许读取')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('outside-read', 'read_file', { path: outsidePath }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-allow-outside' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  // allow 只跳过规则未要求的默认审批；工作区外读取仍必须经过审批。
  expect(fixture.approvalRequests).toHaveLength(1);
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({
    is_error: false,
    output: { content: '工作区外内容' },
  });
});

it('Hook 故障与无效 JSON 只提示，不改变工具错误码，工具仍按原审批路径执行', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [
        commandHook('exit 7'),
        commandHook("printf '{bad json'"),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('failure-write', 'write_file', { path: 'out.txt', content: '故障后执行' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-failures' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('退出码 7');
  expect(result.stderr).toContain('stdout JSON 无效');
  expect(fixture.approvalRequests).toHaveLength(1);
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('故障后执行');
  expect(result.stdout + result.stderr).not.toContain('TIMEOUT');
  expect(result.stdout + result.stderr).not.toContain('TOOL_EXECUTION_ERROR');
});

it('PreToolUse 执行期间暂停整轮总时限并在结束后恢复', async () => {
  const payload = JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: '慢 Hook 允许' },
  });
  const { workspace, home, fixture } = await setup({
    timeoutMs: 800,
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [commandHook(`sleep 1; printf '%s' '${payload}'`)] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('slow-hook-write', 'write_file', { path: 'out.txt', content: '慢 Hook 后写入' }),
  ] } : { content: '完成' });

  const started = performance.now();
  const result = await run({ workspace, home, conversationId: 'pre-tool-timeout-pause' });
  const duration = performance.now() - started;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  // Hook 自身耗时超过整轮时限；若未暂停会在 Hook 执行中被 TIMEOUT 终止。
  expect(duration).toBeGreaterThanOrEqual(1000);
  expect(result.stdout + result.stderr).not.toContain('TIMEOUT');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('慢 Hook 后写入');
});

it.skipIf(process.platform === 'win32')('ask 强制人工审批并展示 Hook 理由', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'default' },
    permissions: { allow: ['Write'] },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [decisionHook('ask', '需要人工确认')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('human-ask-write', 'write_file', { path: 'out.txt', content: '人工确认内容' }),
  ] } : { content: '人工审批完成' });

  let output = '';
  const child = startCLI({
    cwd: workspace,
    userDir: home,
    args: ['--trust-hooks'],
    pty: true,
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }, (text) => { output = text; });
  await waitForOutput(() => output, '> ');
  child.send('执行写入\n');
  await waitForOutput(() => output, 'Hook 审批说明：需要人工确认');
  await waitForOutput(() => output, '1. 批准本次');
  child.send('1\r');
  await waitForOutput(() => output, '人工审批完成');
  child.end('/exit\n');

  const result = await child.done;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('Hook 审批说明：需要人工确认');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('人工确认内容');
});

async function waitForOutput(readOutput: () => string, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!readOutput().includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(readOutput()).toContain(text);
}

it('合法 updatedInput 经 schema 校验后成为审批输入、审批细节与实际执行参数', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [
        updateHook({ path: 'rewritten.txt', content: '改写后的内容' }, { decision: 'ask', reason: '改写后请审批' }),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('updated-write', 'write_file', { path: 'original.txt', content: '原始内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-updated-valid' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(1);
  const payload = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as {
    input: unknown;
    context: { environment: { toolDetails: Record<string, string> } };
  };
  expect(payload.input).toEqual({ path: 'rewritten.txt', content: '改写后的内容' });
  expect(payload.context.environment.toolDetails).toMatchObject({
    requestedPath: 'rewritten.txt',
    target: join(workspace, 'rewritten.txt'),
  });
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'rewritten.txt'), 'utf8')).toBe('改写后的内容');
  await expect(readFile(join(workspace, 'original.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('非法 updatedInput 记为 non_blocking_error、忽略该 Hook 权限结论并回退原输入正常审批', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [
        // write_file 的 inputSchema 要求 content；缺失时整条更新无效。
        updateHook({ path: 'rewritten.txt' }, { decision: 'deny', reason: '不应生效的拒绝' }),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('updated-invalid', 'write_file', { path: 'original.txt', content: '原内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-updated-invalid' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('updatedInput 未通过工具参数校验');
  expect(fixture.approvalRequests).toHaveLength(1);
  const payload = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as { input: unknown };
  expect(payload.input).toEqual({ path: 'original.txt', content: '原内容' });
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'original.txt'), 'utf8')).toBe('原内容');
  await expect(readFile(join(workspace, 'rewritten.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('多个有效 updatedInput 按配置顺序取最后一个，审批与执行结果稳定', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [
        updateHook({ path: 'first.txt', content: '第一份' }),
        updateHook({ path: 'second.txt', content: '第二份' }),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('updated-order', 'write_file', { path: 'original.txt', content: '原始内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-updated-order' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(1);
  const payload = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as { input: unknown };
  expect(payload.input).toEqual({ path: 'second.txt', content: '第二份' });
  expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('第二份');
  await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(workspace, 'original.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  {
    name: 'settings deny 规则优先于 Hook allow 的改写',
    hooks: [updateHook({ path: 'rewritten.txt', content: '试图绕过' }, { decision: 'allow', reason: 'Hook 允许' })],
    permissions: { deny: ['Write'] },
    approvalRequests: 0,
  },
  {
    name: 'Hook deny 优先于同一次改写',
    hooks: [updateHook({ path: 'rewritten.txt', content: '不应写入' }, { decision: 'deny', reason: 'Hook 拒绝' })],
    permissions: {},
    approvalRequests: 0,
  },
])('$name', async ({ hooks, permissions, approvalRequests }) => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    permissions,
    hooks: { PreToolUse: [{ matcher: 'write_file', hooks }] },
  }, (_request, index) => index === 1 ? { calls: [
    call('updated-denied', 'write_file', { path: 'original.txt', content: '原始内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-updated-denied' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(approvalRequests);
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  await expect(readFile(join(workspace, 'rewritten.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(workspace, 'original.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('改写后的输入仍须满足 settings ask 规则，不能借 Hook allow 跳过审批', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    permissions: { ask: ['Write'] },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [
        updateHook({ path: 'rewritten.txt', content: '仍需审批' }, { decision: 'allow', reason: 'Hook 允许' }),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('updated-ask', 'write_file', { path: 'original.txt', content: '原始内容' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'pre-tool-updated-ask' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.approvalRequests).toHaveLength(1);
  const payload = JSON.parse(fixture.approvalRequests[0]!.messages.at(-1)!.content) as { input: unknown };
  expect(payload.input).toEqual({ path: 'rewritten.txt', content: '仍需审批' });
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(await readFile(join(workspace, 'rewritten.txt'), 'utf8')).toBe('仍需审批');
});

it('deny 阻止 Bash 执行且 stdin 携带 prepare 后的命令与解析目录', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('sh ./bash-pre-hook.sh')] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('deny-bash', 'Bash', { command: 'touch should-not-exist.txt' }),
    call('runtime-after', 'runtimeInfo', {}),
  ] } : { content: '已处理' });
  await writeFile(join(workspace, 'bash-pre-hook.sh'), [
    'cat > bash-pre-input.json',
    "if grep -q 'touch' bash-pre-input.json; then printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"禁止命令\"}}'; fi",
  ].join('\n'));

  const result = await run({ workspace, home, conversationId: 'pre-tool-bash-deny' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['deny-bash', 'runtime-after']);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: false });
  await expect(readFile(join(workspace, 'should-not-exist.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  const input = JSON.parse(await readFile(join(workspace, 'bash-pre-input.json'), 'utf8')) as {
    tool_input: Record<string, unknown>;
  };
  expect(input).toMatchObject({
    session_id: 'pre-tool-bash-deny',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'deny-bash',
    tool_input: {
      command: 'touch should-not-exist.txt',
      cwd: workspace,
      requestedCwd: '.',
      approvedCwd: workspace,
      plan: { mode: 'host', reason: 'disabled' },
    },
  });
});
