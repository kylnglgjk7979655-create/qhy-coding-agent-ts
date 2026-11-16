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

async function setup(settings: Record<string, unknown>, respond?: Respond) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-session-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-session-home-')));
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

it('SessionStart(startup) 在第一次模型请求前注入隐藏上下文并收到完整 stdin', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [commandHook('sh ./startup-hook.sh')] }],
    },
  });
  await writeFile(join(workspace, 'startup-hook.sh'), [
    'cat > hook-input.json',
    'pwd > hook-cwd.txt',
    'printf %s "$HOOK_TEST_ENV" > hook-env.txt',
    "printf '项目规则：始终使用中文。'",
  ].join('\n'));

  const result = await run({ workspace, home, conversationId: 'session-start' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  expect(users).toHaveLength(2);
  expect(users[0]).toContain('<hook-context event="SessionStart">');
  expect(users[0]).toContain('项目规则：始终使用中文。');
  expect(users[1]).toBe('用户目标');

  const input = JSON.parse(await readFile(join(workspace, 'hook-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    session_id: 'session-start',
    cwd: workspace,
    approval_mode: 'human',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  expect(input.transcript_path).toContain('session-start');
  expect(await readFile(join(workspace, 'hook-cwd.txt'), 'utf8')).toBe(`${workspace}\n`);
  expect(await readFile(join(workspace, 'hook-env.txt'), 'utf8')).toBe('inherited-env');

  const record = JSON.parse(await readFile(
    join(home, '.qhy-coding-agents', 'sessions', 'session-start', 'record.json'),
    'utf8',
  )) as { effectiveHistory: Array<{ role: string; content: unknown }> };
  const persisted = record.effectiveHistory.filter(({ role }) => role === 'user');
  expect(persisted).toHaveLength(2);
  expect(persisted[0]!.content).toContain('项目规则：始终使用中文。');
});

it('同一进程内多轮对话只注入一次 SessionStart 上下文', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: { SessionStart: [{ hooks: [commandHook("printf '只注入一次'")] }] },
  });

  const result = await run({ workspace, home, conversationId: 'session-once', input: '第一轮\n第二轮\n/exit\n' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  for (const request of fixture.requests) {
    const contexts = request.messages.filter(({ content }) => content.includes('<hook-context'));
    expect(contexts).toHaveLength(1);
  }
  expect(userMessages(fixture.requests[1]!).filter((content) => content === '第一轮' || content === '第二轮'))
    .toEqual(['第一轮', '第二轮']);
});

it('approval.mode=auto 在 stdin 中映射为 model', async () => {
  const { workspace, home } = await setup({
    approval: { mode: 'auto' },
    hooks: { SessionStart: [{ hooks: [commandHook('cat > hook-input-auto.json')] }] },
  });

  const result = await run({ workspace, home, conversationId: 'session-auto' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(workspace, 'hook-input-auto.json'), 'utf8'))).toMatchObject({
    approval_mode: 'model',
    source: 'startup',
  });
});

it('多个匹配 Hook 并行执行、按配置顺序注入，matcher 按 startup 过滤', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [
        { matcher: 'startup|resume', hooks: [commandHook("sleep 0.8; printf '第一'")] },
        { matcher: 'startup', hooks: [commandHook("sleep 0.8; printf '第二'")] },
        { matcher: 'resume', hooks: [commandHook('touch resume-hook-ran')] },
        { matcher: '^startup$', hooks: [commandHook("printf '第三'")] },
        { matcher: '*', hooks: [commandHook("printf '第四'")] },
        { matcher: '', hooks: [commandHook("printf '第五'")] },
      ],
    },
  });
  const started = performance.now();
  const result = await run({ workspace, home, conversationId: 'session-many' });
  const duration = performance.now() - started;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const users = userMessages(fixture.requests[0]!);
  expect(users).toHaveLength(6);
  expect(users.slice(0, 5).map((content) => content.match(/>\n([^\n<]+)\n</)?.[1]))
    .toEqual(['第一', '第二', '第三', '第四', '第五']);
  // 两个 800ms 的 Hook 若是串行至少 1600ms；并行应当明显更快。
  expect(duration).toBeLessThan(1400);
  await expect(readFile(join(workspace, 'resume-hook-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('exit 0 的 JSON additionalContext 与普通 stdout 都注入；故障与 exit 2 不中止启动', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [
        commandHook(`printf '{"hookSpecificOutput":{"additionalContext":"JSON 上下文"}}'`),
        commandHook("printf '普通 上下文'"),
        commandHook("printf '需要补充规则' >&2; exit 2"),
        commandHook("printf '{bad json'"),
        commandHook('exit 7'),
        commandHook('sleep 2', 150),
      ] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'session-failures' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  const users = userMessages(fixture.requests[0]!);
  const contexts = users.filter((content) => content.includes('<hook-context'));
  expect(contexts).toHaveLength(3);
  expect(contexts[0]).toContain('JSON 上下文');
  expect(contexts[1]).toContain('普通 上下文');
  expect(contexts[2]).toContain('需要补充规则');
  expect(users.at(-1)).toBe('用户目标');
  expect(result.stderr).toContain('stdout JSON 无效');
  expect(result.stderr).toContain('退出码 7');
  expect(result.stderr).toContain('执行超时');
});

it('stdout 超过 1 MiB 时终止 Hook 并只提示；注入文本超过 8000 字符时截断', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [
        commandHook('yes x'),
        commandHook(`${process.execPath} -e "process.stdout.write('y'.repeat(9000))"`),
      ] }],
    },
  });

  const started = performance.now();
  const result = await run({ workspace, home, conversationId: 'session-limits' });
  const duration = performance.now() - started;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('stdout 超过 1 MiB');
  const users = userMessages(fixture.requests[0]!);
  const contexts = users.filter((content) => content.includes('<hook-context'));
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toContain('y'.repeat(8000));
  expect(contexts[0]).not.toContain('y'.repeat(8001));
  expect(contexts[0]).toContain('已截断');
  expect(duration).toBeLessThan(2000);
});

it('stderr 超过 64 KiB 时截断并带标记，Hook 仍按普通 stdout 注入', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [commandHook(
        `${process.execPath} -e "process.stderr.write('e'.repeat(70000)); process.stdout.write('stderr-limit-context')"`,
      )] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'session-stderr' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(userMessages(fixture.requests[0]!).some((content) => content.includes('stderr-limit-context'))).toBe(true);
  expect(result.stderr).not.toContain('e'.repeat(1000));
});

it('disableAllHooks、--no-hooks 与未信任时 Hook 不执行', async () => {
  for (const [index, scenario] of [
    { name: 'disableAllHooks', settings: { disableAllHooks: true }, args: ['--trust-hooks'] },
    { name: '--no-hooks', settings: {}, args: ['--no-hooks', '--trust-hooks'] },
    { name: '未信任', settings: {}, args: [] },
  ].entries()) {
    const { workspace, home, fixture } = await setup({
      ...scenario.settings,
      hooks: { SessionStart: [{ hooks: [commandHook('touch should-not-run')] }] },
    });
    const result = await run({ workspace, home, args: scenario.args, conversationId: `session-disabled-${index}` });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    await expect(readFile(join(workspace, 'should-not-run'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(userMessages(fixture.requests[0]!)).toEqual(['用户目标']);
  }
});

it('smoke 探针轮次不运行 Hook', async () => {
  const { workspace, home } = await setup({
    hooks: { SessionStart: [{ hooks: [commandHook('touch smoke-hook-ran')] }] },
  }, (request) => {
    const last = request.messages.at(-1)!;
    if (last.role === 'user') {
      const path = /读取 ([^，。\s]+)/.exec(last.content)?.[1];
      return path === undefined ? { content: '无法识别探针' } : { calls: [call('smoke-read', 'read_file', { path })] };
    }
    const toolContent = request.messages.filter(({ role }) => role === 'tool').at(-1)?.content;
    const probe = toolContent === undefined ? '' : (JSON.parse(toolContent) as { output: { content: string } }).output.content;
    return { content: probe };
  });

  const result = await startCLI({
    cwd: workspace,
    userDir: home,
    args: ['--smoke-tool', '--trust-hooks'],
    input: '',
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }).done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  await expect(readFile(join(workspace, 'smoke-hook-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('/clear 新建会话时重新运行 SessionStart(startup)，每次新会话只注入一次', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [commandHook(
        "count=$(cat hook-runs 2>/dev/null || printf 0); count=$((count + 1)); printf %s \"$count\" > hook-runs; printf \"上下文$count\"",
      )] }],
    },
  });

  const result = await run({
    workspace,
    home,
    input: '第一轮\n/clear\n第二轮\n/exit\n',
    conversationId: 'session-clear',
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  expect(userMessages(fixture.requests[0]!)).toEqual([expect.stringContaining('上下文1'), '第一轮']);
  expect(userMessages(fixture.requests[1]!)).toEqual([expect.stringContaining('上下文2'), '第二轮']);
  expect(await readFile(join(workspace, 'hook-runs'), 'utf8')).toBe('2');
});