import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

async function setup(settings: Record<string, unknown>, respond?: Respond) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-observability-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-observability-home-')));
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
  env?: NodeJS.ProcessEnv;
}) {
  return startCLI({
    cwd: options.workspace,
    userDir: options.home,
    input: options.input ?? '用户目标\n/exit\n',
    args: options.args ?? ['--trust-hooks'],
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    env: { HOOK_TEST_KEY: 'hook-test-secret', ...options.env },
  }).done;
}

function commandHook(command: string, timeoutMs?: number) {
  return { type: 'command' as const, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function userMessages(request: FixtureRequest): string[] {
  return request.messages.filter(({ role }) => role === 'user').map(({ content }) => content);
}

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

/** 只解析结构化日志行；UI 行以 `[hook]` 开头，不会被误当成 JSON。 */
function logRecords(stderr: string): Array<Record<string, unknown>> {
  return stderr.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

it('systemMessage 只给用户，additionalContext 只进入模型请求', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook(
        `printf '{"systemMessage":"用户可见提示","hookSpecificOutput":{"additionalContext":"模型补充资料"}}'`,
      )] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'hook-audience' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  const requestText = JSON.stringify(fixture.requests[0]);
  expect(requestText).toContain('模型补充资料');
  expect(requestText).not.toContain('用户可见提示');
  expect(result.stderr).toContain('用户可见提示');
  expect(result.stderr).not.toContain('模型补充资料');
  // 原始 JSON 不属于用户可见内容。
  expect(result.stderr).not.toContain('hookSpecificOutput');
});

it('suppressOutput 不改变 JSON 字段生效与上下文注入，只隐藏原始 stdout', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook(
        `printf '{"suppressOutput":true,"systemMessage":"保留提示","hookSpecificOutput":{"additionalContext":"保留上下文"}}'`,
      )] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'hook-suppress-output' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('保留提示');
  expect(userMessages(fixture.requests[0]!)).toContainEqual(expect.stringContaining('保留上下文'));
  expect(result.stderr).not.toContain('保留上下文');
  expect(result.stderr).not.toContain('suppressOutput');
});

it('结构化日志只记录元数据，不打印 stdin、参数或输出正文', async () => {
  const toolSecret = 'tool-secret-value-7391';
  const stdoutSecret = 'stdout-secret-8821';
  const stderrSecret = 'stderr-secret-9932';
  const { workspace, home } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'write_file', hooks: [commandHook([
        'cat >/dev/null',
        `printf '${stdoutSecret}'`,
        `printf '${stderrSecret}' >&2`,
        'exit 7',
      ].join('\n'))] }],
    },
  }, (_request, index) => index === 1
    ? { calls: [call('log-write', 'write_file', { path: 'out.txt', content: toolSecret })] }
    : { content: '完成' });

  const result = await run({ workspace, home, conversationId: 'hook-log-redaction' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('退出码 7');
  const records = logRecords(result.stderr);
  const started = records.find((record) => record.event === 'hook.started');
  const failed = records.find((record) => record.event === 'hook.failed');
  expect(started).toMatchObject({ hookEvent: 'PreToolUse', hook: 'PreToolUse:0' });
  expect(failed).toMatchObject({
    hookEvent: 'PreToolUse',
    hook: 'PreToolUse:0',
    outcome: 'non_blocking_error',
    failureKind: 'exit_code',
    exitCode: 7,
  });
  expect(typeof failed!.durationMs).toBe('number');
  expect(failed!.stdoutBytes).toBeGreaterThan(0);
  expect(failed!.stderrBytes).toBeGreaterThan(0);

  const allowed = new Set([
    'timestamp', 'event', 'hookEvent', 'hook', 'durationMs',
    'exitCode', 'outcome', 'failureKind', 'stdoutBytes', 'stderrBytes',
  ]);
  for (const record of records.filter(({ event }) => String(event).startsWith('hook.'))) {
    expect(Object.keys(record).filter((key) => !allowed.has(key))).toEqual([]);
  }
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(toolSecret);
  expect(serialized).not.toContain(stdoutSecret);
  expect(serialized).not.toContain(stderrSecret);
});

it('hook.finished 记录成功元数据，且默认日志不含输出正文', async () => {
  const systemMessage = '仅用户可见';
  const { workspace, home } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'read_file', hooks: [commandHook(
        `printf '{"systemMessage":"${systemMessage}"}'`,
      )] }],
    },
  }, (_request, index) => index === 1
    ? { calls: [call('log-read', 'read_file', { path: 'note.txt' })] }
    : { content: '完成' });
  await writeFile(join(workspace, 'note.txt'), '笔记');

  const result = await run({ workspace, home, conversationId: 'hook-log-finished' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const finished = logRecords(result.stderr).find((record) => record.event === 'hook.finished');
  expect(finished).toMatchObject({
    hookEvent: 'PreToolUse',
    hook: 'PreToolUse:0',
    exitCode: 0,
    outcome: 'success',
  });
  expect(finished).not.toHaveProperty('failureKind');
  expect(finished).not.toHaveProperty('stdout');
  expect(finished).not.toHaveProperty('stderr');
  expect(result.stderr).toContain(systemMessage);
});

it('显式调试开关才把 Hook 输出正文写入日志，suppressOutput 仍可隐藏 stdout', async () => {
  const { workspace, home } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'read_file', hooks: [commandHook("printf 'debug-visible-output'")] }],
    },
  }, (_request, index) => index === 1
    ? { calls: [call('debug-read', 'read_file', { path: 'note.txt' })] }
    : { content: '完成' });
  await writeFile(join(workspace, 'note.txt'), '笔记');

  const result = await run({
    workspace,
    home,
    conversationId: 'hook-debug-output',
    env: { QHY_HOOK_DEBUG: '1' },
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const finished = logRecords(result.stderr).find((record) => record.event === 'hook.finished');
  expect(finished?.stdout).toBe('debug-visible-output');

  const suppressed = await setup({
    approval: { mode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'read_file', hooks: [commandHook(
        `printf '{"suppressOutput":true,"systemMessage":"提示"}'`,
      )] }],
    },
  }, (_request, index) => index === 1
    ? { calls: [call('debug-suppressed-read', 'read_file', { path: 'note.txt' })] }
    : { content: '完成' });
  await writeFile(join(suppressed.workspace, 'note.txt'), '笔记');
  const suppressedResult = await run({
    workspace: suppressed.workspace,
    home: suppressed.home,
    conversationId: 'hook-debug-suppressed',
    env: { QHY_HOOK_DEBUG: '1' },
  });

  expect(suppressedResult.code, suppressedResult.stdout + suppressedResult.stderr).toBe(0);
  const hidden = logRecords(suppressedResult.stderr).find((record) => record.event === 'hook.finished');
  expect(hidden).not.toHaveProperty('stdout');
});

it('用户可见 UI 行按 500 字符截断', async () => {
  const { workspace, home } = await setup({
    hooks: {
      SessionStart: [{ hooks: [commandHook(
        `${process.execPath} -e "process.stdout.write(JSON.stringify({systemMessage:'x'.repeat(600)}))"`,
      )] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'hook-ui-truncate' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const visible = result.stderr.split('\n').find((line) => line.startsWith('[hook] SessionStart:'));
  expect(visible).toContain(`${'x'.repeat(500)}…`);
  expect(visible).not.toContain('x'.repeat(501));
});