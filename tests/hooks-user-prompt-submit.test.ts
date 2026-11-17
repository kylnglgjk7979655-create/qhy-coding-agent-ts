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
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-prompt-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-prompt-home-')));
  workspaces.push(workspace);
  homes.push(home);
  const fixture = await startLocalOpenAIModel(respond ?? (() => ({ content: '已完成' })));
  fixtures.push(fixture);
  await mkdir(join(workspace, '.agent'), { recursive: true });
  await writeSettings(workspace, fixture, settings);
  return { workspace, home, fixture };
}

async function writeSettings(
  workspace: string,
  fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>,
  settings: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
    model: 'hook-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'HOOK_TEST_KEY',
    timeoutMs: 3000,
    ...settings,
  }));
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
    env: { HOOK_TEST_KEY: 'hook-test-secret', HOOK_TEST_ENV: 'inherited-env', ...options.env },
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

async function record(home: string, conversationId: string) {
  return readStoredSession(home, conversationId);
}

function messageText(message: { role: string; content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

it('UserPromptSubmit 附加上下文排在用户消息之后、进入第一次模型请求并持久化', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [
        commandHook(`printf '{"hookSpecificOutput":{"additionalContext":"JSON 上下文"}}'`),
        commandHook("printf '普通上下文'"),
        commandHook('cat > prompt-input.json'),
      ] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'user-prompt-context' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  expect(users).toHaveLength(3);
  expect(users[0]).toBe('用户目标');
  expect(users[1]).toContain('<hook-context event="UserPromptSubmit">');
  expect(users[1]).toContain('JSON 上下文');
  expect(users[2]).toContain('<hook-context event="UserPromptSubmit">');
  expect(users[2]).toContain('普通上下文');

  const input = JSON.parse(await readFile(join(workspace, 'prompt-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    session_id: 'user-prompt-context',
    cwd: workspace,
    approval_mode: 'human',
    hook_event_name: 'UserPromptSubmit',
    prompt: '用户目标',
  });
  expect(typeof input.transcript_path).toBe('string');

  const stored = await record(home, 'user-prompt-context');
  const persisted = stored.effectiveHistory.filter(({ role }) => role === 'user').map(messageText);
  expect(persisted[0]).toBe('用户目标');
  expect(persisted[1]).toContain('JSON 上下文');
  expect(persisted[2]).toContain('普通上下文');
});

it('exit 2 取消本轮：无模型请求、不把原 prompt 送入模型，下一次提交仍可处理', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook([
        'input=$(cat)',
        'case "$input" in',
        "  *禁止*) printf '禁止提交本轮' >&2; exit 2 ;;",
        'esac',
        "printf '允许上下文'",
      ].join('\n'))] }],
    },
  });

  const result = await run({
    workspace,
    home,
    input: '禁止提交\n允许提交\n/exit\n',
    conversationId: 'user-prompt-exit-2',
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('禁止提交本轮');
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  expect(users[0]).toBe('允许提交');
  expect(users[1]).toContain('允许上下文');
  expect(JSON.stringify(fixture.requests[0])).not.toContain('禁止提交');

  const stored = await record(home, 'user-prompt-exit-2');
  expect(stored.rounds.map(({ status }) => status)).toEqual(['succeeded']);
  expect(JSON.stringify(stored.effectiveHistory)).not.toContain('禁止提交');
});

it('decision 为 block 时阻止本轮，不发出模型请求并显示原因', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook(
        `printf '{"decision":"block","reason":"策略拒绝本轮"}'`,
      )] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'user-prompt-block' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('策略拒绝本轮');
  expect(fixture.requests).toHaveLength(0);
  const stored = await record(home, 'user-prompt-block');
  expect(stored.rounds).toHaveLength(0);
  expect(JSON.stringify(stored.effectiveHistory)).not.toContain('用户目标');
});

it('continue 为 false 时保留原 prompt 并停止本轮，后续提交可见该 prompt', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook([
        'input=$(cat)',
        'case "$input" in',
        "  *保留目标*) printf '{\"continue\":false,\"reason\":\"暂停后续处理\"}'; exit 0 ;;",
        'esac',
        "printf '后续上下文'",
      ].join('\n'))] }],
    },
  });

  const result = await run({
    workspace,
    home,
    input: '保留目标\n继续目标\n/exit\n',
    conversationId: 'user-prompt-continue-false',
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('暂停后续处理');
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  expect(users[0]).toBe('保留目标');
  expect(users[1]).toBe('继续目标');
  expect(users[2]).toContain('后续上下文');

  const stored = await record(home, 'user-prompt-continue-false');
  expect(stored.rounds.map(({ status }) => status)).toEqual(['succeeded']);
  expect(JSON.stringify(stored.effectiveHistory)).toContain('保留目标');
});

it('空 matcher 与任意 matcher 都不影响该事件；超时或故障只提示不阻止', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [
        { matcher: '^no-such-query$', hooks: [commandHook("printf '不受 matcher 限制的上下文'")] },
        { matcher: '', hooks: [commandHook('sleep 2', 150)] },
        { matcher: '*', hooks: [commandHook('exit 7')] },
      ],
    },
  });

  const started = performance.now();
  const result = await run({ workspace, home, conversationId: 'user-prompt-failures' });
  const duration = performance.now() - started;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  expect(users[0]).toBe('用户目标');
  expect(users[1]).toContain('不受 matcher 限制的上下文');
  expect(result.stderr).toContain('执行超时');
  expect(result.stderr).toContain('退出码 7');
  expect(duration).toBeLessThan(2000);
});

it('后台任务通知轮次不触发 UserPromptSubmit', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      UserPromptSubmit: [{ hooks: [commandHook('printf x >> hook-runs')] }],
    },
  }, (request, index) => {
    const userText = userMessages(request).join('\n');
    if (userText.includes('任务：后台子任务')) return { content: '后台调查结果。' };
    if (index === 1) return { calls: [call('notification-launch', 'agent', {
      description: '后台调查', prompt: '后台子任务', background: true,
    })] };
    if (userText.includes('后台子 Agent 已完成')) return { content: '已收到后台调查结果。' };
    return { content: '主轮次已完成。' };
  });

  let stdout = '';
  const child = startCLI({
    cwd: workspace,
    userDir: home,
    args: ['--trust-hooks'],
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }, (text) => { stdout = text; });
  child.send('启动后台调查\n');
  await waitForRequests(fixture.requests, 4);
  await waitForOutput(() => stdout, '已收到后台调查结果。', 1);
  child.end('/exit\n');
  const result = await child.done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  // 只有最初的真实用户提交触发一次；通知轮次不运行该 Hook。
  expect(await readFile(join(workspace, 'hook-runs'), 'utf8')).toBe('x');
});

async function waitForRequests(requests: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(requests).toHaveLength(count);
}

async function waitForOutput(readOutput: () => string, text: string, occurrences: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (readOutput().split(text).length - 1 < occurrences && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(readOutput().split(text).length - 1).toBeGreaterThanOrEqual(occurrences);
}