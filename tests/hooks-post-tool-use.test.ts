import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { readStoredSession } from './helpers/session-store.js';

const homes: string[] = [];
const workspaces: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Respond = (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>;

async function setup(settings: Record<string, unknown>, respond?: Respond) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-post-tool-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-post-tool-home-')));
  workspaces.push(workspace);
  homes.push(home);
  const fixture = await startLocalOpenAIModel(respond ?? (() => ({ content: '已完成' })));
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

function commandHook(command: string, timeoutMs?: number) {
  return { type: 'command' as const, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
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

function userTexts(request: FixtureRequest): string[] {
  return request.messages.filter(({ role }) => role === 'user').map(({ content }) => content);
}

async function record(home: string, conversationId: string) {
  return readStoredSession(home, conversationId);
}

it('成功工具调用触发 PostToolUse：stdin 带成功信封与调用标识，反馈排在同批结果之后并持久化', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUse: [{ matcher: 'write_file', hooks: [
        commandHook('sh ./post-hook.sh'),
        commandHook("printf '普通 stdout 不应进入模型'"),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('post-write', 'write_file', { path: 'out.txt', content: '写入内容' }),
  ] } : { content: '完成' });
  await writeFile(join(workspace, 'post-hook.sh'), [
    'cat > post-input.json',
    "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"请检查写入结果\"}}'",
  ].join('\n'));

  const result = await run({ workspace, home, conversationId: 'post-tool-success' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['post-write']);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: false, output: { success: true } });
  expect(await readFile(join(workspace, 'out.txt'), 'utf8')).toBe('写入内容');

  const input = JSON.parse(await readFile(join(workspace, 'post-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    session_id: 'post-tool-success',
    cwd: workspace,
    approval_mode: 'model',
    hook_event_name: 'PostToolUse',
    tool_name: 'write_file',
    tool_use_id: 'post-write',
    tool_input: {
      path: 'out.txt',
      content: '写入内容',
      target: join(workspace, 'out.txt'),
    },
    tool_response: { is_error: false, output: { success: true } },
  });
  expect(typeof input.transcript_path).toBe('string');

  const nextRequest = fixture.requests.at(-1)!;
  const feedback = userTexts(nextRequest).filter((content) => content.includes('<hook-feedback'));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain('event="PostToolUse"');
  expect(feedback[0]).toContain('hook="PostToolUse:0"');
  expect(feedback[0]).toContain('请检查写入结果');
  expect(nextRequest.messages.some(({ content }) => (content ?? '').includes('普通 stdout 不应进入模型'))).toBe(false);
  // 反馈在所有工具结果之后，不插进工具调用与结果的配对之间。
  const lastToolIndex = nextRequest.messages.findLastIndex(({ role }) => role === 'tool');
  const feedbackIndex = nextRequest.messages.findIndex(({ content }) => (content ?? '').includes('<hook-feedback'));
  expect(feedbackIndex).toBeGreaterThan(lastToolIndex);

  const stored = await record(home, 'post-tool-success');
  const persisted = stored.effectiveHistory
    .filter(({ role }) => role === 'user')
    .map(({ content }) => typeof content === 'string' ? content : JSON.stringify(content));
  expect(persisted.some((content) => content.includes('请检查写入结果'))).toBe(true);
});

it('decision block 只作为反馈：文件副作用保留、工具结果不变，反馈在下一次请求可见', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUse: [{ matcher: 'write_file', hooks: [
        commandHook(`printf '{"decision":"block","reason":"写入后请复核格式"}'`),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('blocked-post-write', 'write_file', { path: 'kept.txt', content: '副作用保留' }),
    call('read-after-post', 'read_file', { path: 'kept.txt' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-block' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(await readFile(join(workspace, 'kept.txt'), 'utf8')).toBe('副作用保留');
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['blocked-post-write', 'read-after-post']);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: false, output: { success: true } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: false, output: { content: '副作用保留' } });
  expect(result.stderr).toContain('写入后请复核格式');

  const nextRequest = fixture.requests.at(-1)!;
  const feedbackIndex = nextRequest.messages.findIndex(({ content }) => (content ?? '').includes('写入后请复核格式'));
  const lastToolIndex = nextRequest.messages.findLastIndex(({ role }) => role === 'tool');
  expect(feedbackIndex).toBeGreaterThan(lastToolIndex);
  expect(userTexts(nextRequest).some((content) => content.includes(
    '<hook-feedback event="PostToolUse" hook="PostToolUse:0">\n写入后请复核格式\n</hook-feedback>',
  ))).toBe(true);
});

it('exit 2 的 stderr 理由作为反馈，普通 stdout 不注入，工具结果保持成功', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUse: [{ matcher: 'write_file', hooks: [
        commandHook("printf '普通 stdout'"),
        commandHook("printf 'exit 2 复核理由' >&2; exit 2"),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('exit-two-write', 'write_file', { path: 'exit-two.txt', content: '已写入' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-exit-two' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(await readFile(join(workspace, 'exit-two.txt'), 'utf8')).toBe('已写入');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  const nextRequest = fixture.requests.at(-1)!;
  const feedback = userTexts(nextRequest).filter((content) => content.includes('<hook-feedback'));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain('exit 2 复核理由');
  expect(nextRequest.messages.some(({ content }) => (content ?? '').includes('普通 stdout'))).toBe(false);
});

it('多个 Hook 并行执行且反馈按配置顺序稳定', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      PostToolUse: [{ matcher: 'read_file', hooks: [
        commandHook([
          'touch first.started',
          'sleep 0.4',
          'touch first.done',
          "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"第一条反馈\"}}'",
        ].join('\n')),
        commandHook([
          'while [ ! -f first.started ]; do sleep 0.01; done',
          'if [ -f first.done ]; then printf serial > concurrency.txt; else printf parallel > concurrency.txt; fi',
          "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"第二条反馈\"}}'",
        ].join('\n')),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('parallel-post-read', 'read_file', { path: 'note.txt' }),
  ] } : { content: '完成' });
  await writeFile(join(workspace, 'note.txt'), '笔记');

  const result = await run({ workspace, home, conversationId: 'post-tool-parallel' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(await readFile(join(workspace, 'concurrency.txt'), 'utf8')).toBe('parallel');
  const feedback = userTexts(fixture.requests.at(-1)!)
    .filter((content) => content.includes('<hook-feedback'));
  expect(feedback).toHaveLength(2);
  expect(feedback[0]).toContain('第一条反馈');
  expect(feedback[0]).toContain('hook="PostToolUse:0"');
  expect(feedback[1]).toContain('第二条反馈');
  expect(feedback[1]).toContain('hook="PostToolUse:1"');
});

it('权限拒绝与执行失败不触发 PostToolUse', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [commandHook(
        "cat > pre-input.json; if grep -q 'denied.txt' pre-input.json; then "
        + "printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"拒绝写入\"}}'; fi",
      )] }],
      PostToolUse: [{ matcher: 'write_file', hooks: [commandHook(
        "touch post-ran.txt; printf '{\"hookSpecificOutput\":{\"additionalContext\":\"不应出现的反馈\"}}'",
      )] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('denied-post', 'write_file', { path: 'denied.txt', content: '被拒绝' }),
    call('failed-post', 'write_file', { path: 'missing/out.txt', content: '无父目录' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-not-triggered' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResults = results(fixture);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  await expect(readFile(join(workspace, 'post-ran.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.requests.at(-1)!.messages.some(({ content }) => (content ?? '').includes('<hook-feedback'))).toBe(false);
});

it('Hook 超时与故障只提示，不改变成功工具结果，也不注入反馈', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUse: [{ matcher: 'write_file', hooks: [
        commandHook('sleep 2', 150),
        commandHook('exit 7'),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('failure-post-write', 'write_file', { path: 'failure.txt', content: '仍写入' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-failures' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('执行超时');
  expect(result.stderr).toContain('退出码 7');
  expect(await readFile(join(workspace, 'failure.txt'), 'utf8')).toBe('仍写入');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({ is_error: false });
  expect(fixture.requests.at(-1)!.messages.some(({ content }) => (content ?? '').includes('<hook-feedback'))).toBe(false);
});