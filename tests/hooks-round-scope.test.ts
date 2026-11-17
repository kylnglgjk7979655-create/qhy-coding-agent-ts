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
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-round-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-round-home-')));
  workspaces.push(workspace);
  homes.push(home);
  const fixture = await startLocalOpenAIModel(respond ?? (() => ({ content: '已完成' })));
  fixtures.push(fixture);
  await mkdir(join(workspace, '.agent'), { recursive: true });
  await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
    model: 'hook-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'HOOK_TEST_KEY',
    timeoutMs: 5000,
    ...settings,
  }));
  return { workspace, home, fixture };
}

function commandHook(command: string) {
  return { type: 'command' as const, command };
}

function eventHook(file: string, event: string, output?: string) {
  return commandHook([
    `printf '${event}\\n' >> ${file}`,
    ...(output === undefined ? [] : [`printf '${output}'`]),
  ].join('\n'));
}

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function userMessages(request: FixtureRequest): string[] {
  return request.messages.filter(({ role }) => role === 'user').map(({ content }) => content);
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

it('smoke 探针轮次不启动任何 Hook、不注入上下文，也不加载或提示信任', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [eventHook('hook-runs', 'SessionStart', '启动上下文')] }],
      UserPromptSubmit: [{ hooks: [eventHook('hook-runs', 'UserPromptSubmit', '提交上下文')] }],
      PreToolUse: [{ hooks: [eventHook('hook-runs', 'PreToolUse', '预工具上下文')] }],
      PostToolUse: [{ hooks: [eventHook('hook-runs', 'PostToolUse', '后工具上下文')] }],
      PostToolUseFailure: [{ hooks: [eventHook('hook-runs', 'PostToolUseFailure', '失败上下文')] }],
      Stop: [{ hooks: [eventHook('hook-runs', 'Stop', '结束上下文')] }],
    },
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
    // 不传 --trust-hooks：smoke 不应加载或提示信任。
    args: ['--smoke-tool'],
    input: '',
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }).done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  expect(await existingFile(join(workspace, 'hook-runs'))).toBeUndefined();
  for (const request of fixture.requests) {
    expect(JSON.stringify(request.messages)).not.toContain('<hook-');
    expect(userMessages(request).every((content) => !content.includes('上下文'))).toBe(true);
  }
  // 信任门禁没有运行：既不提示，也不写入信任记录。
  expect(result.stderr).not.toContain('已禁用全部 Hook');
  expect(result.stderr).not.toContain('未信任的 Hook');
  expect(await existingFile(join(home, '.qhy-coding-agents', 'trusted.json'))).toBeUndefined();
});

it('后台通知轮次只触发 Stop；SessionStart 与 UserPromptSubmit 只在真实用户轮次运行，Stop 反馈进入续跑请求', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      SessionStart: [{ hooks: [eventHook('round-events', 'SessionStart', '启动上下文')] }],
      UserPromptSubmit: [{ hooks: [eventHook('round-events', 'UserPromptSubmit', '提交上下文')] }],
      Stop: [{ hooks: [commandHook([
        'input=$(cat)',
        `printf '%s\\n' "$input" >> stop-inputs.jsonl`,
        `printf 'Stop\\n' >> round-events`,
        'case "$input" in',
        '  *后台通知处理完成*) printf \'{"decision":"block","reason":"请补充通知细节"}\' ;;',
        'esac',
      ].join('\n'))] }],
    },
  }, (request) => {
    const users = userMessages(request);
    const lastUser = users.at(-1) ?? '';
    if (lastUser.includes('任务：后台子任务')) return { content: '后台结果' };
    // 续跑请求的末端是 Stop 反馈；通知请求本身仍以通知 prompt 结尾。
    if (lastUser.includes('<hook-feedback event="Stop"')) return { content: '续跑完成' };
    if (lastUser.includes('后台子 Agent 已完成')) return { content: '后台通知处理完成' };
    const hasToolResult = request.messages.some(({ role }) => role === 'tool');
    if (users.includes('启动后台调查') && !hasToolResult) {
      return { calls: [call('notification-launch', 'agent', {
        description: '后台调查', prompt: '后台子任务', background: true,
      })] };
    }
    return { content: '主轮次完成' };
  });

  let output = '';
  const cli = startCLI({
    cwd: workspace,
    userDir: home,
    args: ['--trust-hooks'],
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }, (value) => { output = value; });
  cli.send('启动后台调查\n');
  await waitFor(() => output.includes('续跑完成'), () => `输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  const events = (await readFile(join(workspace, 'round-events'), 'utf8')).trim().split('\n');
  // 真实用户轮次、通知轮次、通知轮次的 Stop 续跑各运行一次 Stop。
  expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'Stop', 'Stop']);

  const stopInputs = (await readFile(join(workspace, 'stop-inputs.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(stopInputs.map(({ stop_hook_active }) => stop_hook_active)).toEqual([false, false, true]);
  expect(stopInputs.map(({ last_assistant_message }) => last_assistant_message)).toEqual([
    '主轮次完成', '后台通知处理完成', '续跑完成',
  ]);

  const continuation = fixture.requests.find((request) => request.messages.some(
    ({ role, content }) => role === 'user' && content.includes('请补充通知细节'),
  ));
  expect(continuation).toBeDefined();
  const responseIndex = continuation!.messages.findIndex(
    ({ role, content }) => role === 'assistant' && content === '后台通知处理完成',
  );
  const feedbackIndex = continuation!.messages.findIndex(
    ({ role, content }) => role === 'user' && content.includes('请补充通知细节'),
  );
  expect(feedbackIndex).toBeGreaterThan(responseIndex);
});

it('普通用户轮次触发全部适用事件并保留上下文注入', async () => {
  const { workspace, home, fixture } = await setup({
    approval: { mode: 'auto' },
    hooks: {
      SessionStart: [{ hooks: [eventHook('round-events', 'SessionStart', '启动上下文')] }],
      UserPromptSubmit: [{ hooks: [eventHook('round-events', 'UserPromptSubmit', '提交上下文')] }],
      PreToolUse: [{ hooks: [eventHook('round-events', 'PreToolUse')] }],
      PostToolUse: [{ hooks: [eventHook('round-events', 'PostToolUse')] }],
      Stop: [{ hooks: [eventHook('round-events', 'Stop')] }],
    },
  }, (_request, index) => index === 1
    ? { calls: [call('normal-read', 'read_file', { path: 'note.txt' })] }
    : { content: '读取完成' });
  await writeFile(join(workspace, 'note.txt'), '文件内容');

  const result = await startCLI({
    cwd: workspace,
    userDir: home,
    input: '读取工作区文件\n/exit\n',
    args: ['--trust-hooks'],
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }).done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  const events = (await readFile(join(workspace, 'round-events'), 'utf8')).trim().split('\n');
  expect(events).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

  const users = userMessages(fixture.requests[0]!);
  expect(users[0]).toContain('<hook-context event="SessionStart">');
  expect(users[0]).toContain('启动上下文');
  expect(users[1]).toBe('读取工作区文件');
  expect(users[2]).toContain('<hook-context event="UserPromptSubmit">');
  expect(users[2]).toContain('提交上下文');
});

async function waitFor(predicate: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), message()).toBe(true);
}