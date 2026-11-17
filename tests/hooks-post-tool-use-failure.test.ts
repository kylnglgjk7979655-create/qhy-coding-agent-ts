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
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-post-failure-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-post-failure-home-')));
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

it('工具执行抛错触发 PostToolUseFailure：stdin 带错误与 error_code，反馈排在同批结果之后并持久化', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUseFailure: [{ matcher: 'write_file', hooks: [
        commandHook('sh ./failure-hook.sh'),
        commandHook('sh ./plain-stdout-hook.sh'),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('failed-write', 'write_file', { path: 'missing/out.txt', content: '无父目录' }),
    call('successful-read', 'read_file', { path: 'note.txt' }),
  ] } : { content: '完成' });
  await writeFile(join(workspace, 'note.txt'), '存在');
  await writeFile(join(workspace, 'failure-hook.sh'), [
    'cat > failure-input.json',
    "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"请检查失败原因\"}}'",
  ].join('\n'));
  await writeFile(join(workspace, 'plain-stdout-hook.sh'), "printf '普通 stdout 不应进入模型'");

  const result = await run({ workspace, home, conversationId: 'post-tool-failure' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['failed-write', 'successful-read']);
  const failure = JSON.parse(toolResults[0]!.content) as {
    is_error: boolean;
    error: { code: string; message: string };
  };
  expect(failure).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: false, output: { content: '存在' } });

  const input = JSON.parse(await readFile(join(workspace, 'failure-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    session_id: 'post-tool-failure',
    cwd: workspace,
    approval_mode: 'model',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'write_file',
    tool_use_id: 'failed-write',
    error: failure.error.message,
    error_code: 'TOOL_EXECUTION_ERROR',
    tool_input: {
      path: 'missing/out.txt',
      content: '无父目录',
      target: join(workspace, 'missing/out.txt'),
    },
  });
  expect(typeof input.transcript_path).toBe('string');

  const nextRequest = fixture.requests.at(-1)!;
  const feedback = userTexts(nextRequest).filter((content) => content.includes('<hook-feedback'));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toContain('event="PostToolUseFailure"');
  expect(feedback[0]).toContain('hook="PostToolUseFailure:0"');
  expect(feedback[0]).toContain('请检查失败原因');
  expect(nextRequest.messages.some(({ content }) => (content ?? '').includes('普通 stdout 不应进入模型'))).toBe(false);
  // 反馈在所有工具结果之后，不插进工具调用与结果的配对之间。
  const lastToolIndex = nextRequest.messages.findLastIndex(({ role }) => role === 'tool');
  const feedbackIndex = nextRequest.messages.findIndex(({ content }) => (content ?? '').includes('<hook-feedback'));
  expect(feedbackIndex).toBeGreaterThan(lastToolIndex);

  const stored = await record(home, 'post-tool-failure');
  const persisted = stored.effectiveHistory
    .filter(({ role }) => role === 'user')
    .map(({ content }) => typeof content === 'string' ? content : JSON.stringify(content));
  expect(persisted.some((content) => content.includes('请检查失败原因'))).toBe(true);
});

it('decision block 与 exit 2 只作为反馈：工具结果保持原错误码与错误信息', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUseFailure: [{ matcher: 'write_file', hooks: [
        commandHook(`printf '{"decision":"block","reason":"失败后请复核路径"}'`),
        commandHook("printf 'exit 2 检查父目录' >&2; exit 2"),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('blocked-failure', 'write_file', { path: 'absent/out.txt', content: '仍失败' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-failure-block' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  await expect(readFile(join(workspace, 'absent/out.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const failure = JSON.parse(results(fixture)[0]!.content) as {
    is_error: boolean;
    error: { code: string; message: string };
  };
  expect(failure).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  expect(result.stderr).toContain('失败后请复核路径');

  const nextRequest = fixture.requests.at(-1)!;
  const feedback = userTexts(nextRequest).filter((content) => content.includes('<hook-feedback'));
  expect(feedback).toHaveLength(2);
  expect(feedback[0]).toContain('失败后请复核路径');
  expect(feedback[1]).toContain('检查父目录');
  const lastToolIndex = nextRequest.messages.findLastIndex(({ role }) => role === 'tool');
  const feedbackIndex = nextRequest.messages.findIndex(({ content }) => (content ?? '').includes('失败后请复核路径'));
  expect(feedbackIndex).toBeGreaterThan(lastToolIndex);
});

it('权限拒绝、参数错误与未知工具不触发 PostToolUseFailure', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    permissions: { deny: ['Write'] },
    hooks: {
      PostToolUseFailure: [{ matcher: '*', hooks: [commandHook(
        "touch failure-ran.txt; printf '{\"hookSpecificOutput\":{\"additionalContext\":\"不应出现的反馈\"}}'",
      )] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('denied-call', 'write_file', { path: 'denied.txt', content: '被拒绝' }),
    call('invalid-call', 'write_file', { path: 'invalid.txt' }),
    call('unknown-call', 'not_a_tool', {}),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-failure-not-triggered' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const toolResults = results(fixture);
  expect(toolResults.map(({ tool_call_id }) => tool_call_id)).toEqual(['denied-call', 'invalid-call', 'unknown-call']);
  expect(JSON.parse(toolResults[0]!.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(JSON.parse(toolResults[1]!.content)).toMatchObject({ is_error: true, error: { code: 'INVALID_TOOL_ARGUMENTS' } });
  expect(JSON.parse(toolResults[2]!.content)).toMatchObject({ is_error: true, error: { code: 'UNKNOWN_TOOL' } });
  await expect(readFile(join(workspace, 'failure-ran.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.requests.at(-1)!.messages.some(({ content }) => (content ?? '').includes('<hook-feedback'))).toBe(false);
});

it('PostToolUseFailure 超时与故障只提示，不改变工具错误结果，也不注入反馈', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PostToolUseFailure: [{ matcher: 'write_file', hooks: [
        commandHook('sleep 2', 150),
        commandHook('exit 7'),
      ] }],
    },
  }, (_request, index) => index === 1 ? { calls: [
    call('failure-hook-timeout', 'write_file', { path: 'absent/timeout.txt', content: '仍失败' }),
  ] } : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'post-tool-failure-faults' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('执行超时');
  expect(result.stderr).toContain('退出码 7');
  expect(JSON.parse(results(fixture)[0]!.content)).toMatchObject({
    is_error: true,
    error: { code: 'TOOL_EXECUTION_ERROR' },
  });
  expect(fixture.requests.at(-1)!.messages.some(({ content }) => (content ?? '').includes('<hook-feedback'))).toBe(false);
});