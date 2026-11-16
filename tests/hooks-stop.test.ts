import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse } from './helpers/local-openai-fixture.js';

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
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-stop-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-stop-home-')));
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
  conversationId?: string;
}) {
  return startCLI({
    cwd: options.workspace,
    userDir: options.home,
    input: options.input ?? '用户目标\n/exit\n',
    args: ['--trust-hooks'],
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }).done;
}

function commandHook(command: string, timeoutMs?: number) {
  return { type: 'command' as const, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

async function record(home: string, conversationId: string) {
  return JSON.parse(await readFile(
    join(home, '.qhy-coding-agents', 'sessions', conversationId, 'record.json'),
    'utf8',
  )) as { effectiveHistory: Array<{ role: string; content: unknown }> };
}

function messageText(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => typeof part === 'object' && part !== null && 'text' in part
        ? String((part as { text: unknown }).text)
        : JSON.stringify(part))
      .join('');
  }
  return JSON.stringify(message.content);
}

it('最终回答后触发 Stop：stdin 带停止字段，matcher 不生效，阻止理由排在最终回答之后进入有效历史', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      Stop: [{ matcher: '^no-such-query$', hooks: [commandHook([
        'cat >> stop-inputs.jsonl',
        "printf '\\n' >> stop-inputs.jsonl",
        `printf '{"decision":"block","reason":"下一轮请修正"}'`,
      ].join('\n'))] }],
    },
  }, (_request, index) => ({ content: index === 1 ? '最终回答一' : '最终回答二' }));

  const result = await run({
    workspace,
    home,
    input: '第一问\n第二问\n/exit\n',
    conversationId: 'stop-feedback',
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);

  const inputs = (await readFile(join(workspace, 'stop-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toMatchObject({
    session_id: 'stop-feedback',
    cwd: workspace,
    approval_mode: 'human',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '最终回答一',
  });
  expect(inputs[1]).toMatchObject({
    stop_hook_active: false,
    last_assistant_message: '最终回答二',
  });
  expect(typeof inputs[0]!.transcript_path).toBe('string');

  const secondRequest = fixture.requests[1]!;
  const assistantIndex = secondRequest.messages.findIndex(
    ({ role, content }) => role === 'assistant' && content === '最终回答一',
  );
  const feedbackIndex = secondRequest.messages.findIndex(
    ({ role, content }) => role === 'user' && content.includes('<hook-feedback event="Stop"'),
  );
  const nextPromptIndex = secondRequest.messages.findIndex(
    ({ role, content }) => role === 'user' && content === '第二问',
  );
  expect(assistantIndex).toBeGreaterThanOrEqual(0);
  expect(feedbackIndex).toBeGreaterThan(assistantIndex);
  expect(nextPromptIndex).toBeGreaterThan(feedbackIndex);
  expect(secondRequest.messages[feedbackIndex]!.content).toContain(
    '<hook-feedback event="Stop" hook="Stop:0">\n下一轮请修正\n</hook-feedback>',
  );

  const stored = await record(home, 'stop-feedback');
  const texts = stored.effectiveHistory.map(messageText);
  const finalAnswerIndex = texts.findLastIndex((text) => text === '最终回答二');
  expect(finalAnswerIndex).toBeGreaterThanOrEqual(0);
  expect(texts.slice(finalAnswerIndex + 1)).toContain(
    '<hook-feedback event="Stop" hook="Stop:0">\n下一轮请修正\n</hook-feedback>',
  );
});

it('exit 2 的 stderr 理由作为隐藏反馈；普通 stdout 不注入', async () => {
  const { workspace, home } = await setup({
    hooks: {
      Stop: [{ hooks: [commandHook([
        'cat > stop-input.json',
        "printf '普通 stdout'",
        "printf 'Stop exit 2 理由' >&2",
        'exit 2',
      ].join('\n'))] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'stop-exit-two' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Stop exit 2 理由');
  const input = JSON.parse(await readFile(join(workspace, 'stop-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input).toMatchObject({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '已完成',
  });

  const stored = await record(home, 'stop-exit-two');
  const texts = stored.effectiveHistory.map(messageText);
  const finalAnswerIndex = texts.findLastIndex((text) => text === '已完成');
  expect(finalAnswerIndex).toBeGreaterThanOrEqual(0);
  expect(texts[finalAnswerIndex + 1]).toBe(
    '<hook-feedback event="Stop" hook="Stop:0">\nStop exit 2 理由\n</hook-feedback>',
  );
  expect(texts.join('\n')).not.toContain('普通 stdout');
});

it('用户取消不触发 Stop', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      Stop: [{ hooks: [commandHook('touch stop-ran.txt')] }],
    },
  }, () => ({ frames: [{ delta: { content: '缓慢' }, delayMs: 500 }, { delta: {}, finish_reason: 'stop' }] }));

  let stdout = '';
  const running = startCLI({
    cwd: workspace,
    userDir: home,
    args: ['--trust-hooks'],
    env: { HOOK_TEST_KEY: 'hook-test-secret' },
  }, (text) => { stdout = text; });
  running.send('取消本轮\n');
  await waitFor(() => fixture.requests.length >= 1, '模型请求未开始');
  running.child.kill('SIGINT');
  await waitFor(() => stdout.includes('Interrupt by user'), `未观察到用户中断：${stdout}`);
  running.end('/exit\n');
  const result = await running.done;

  expect(result.code, result.stdout + result.stderr).toBe(0);
  await expect(readFile(join(workspace, 'stop-ran.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('异常终止不触发 Stop', async () => {
  const { workspace, home } = await setup({
    hooks: {
      Stop: [{ hooks: [commandHook('touch stop-ran.txt')] }],
    },
  }, () => ({ frames: [{ delta: { content: '截断回答' }, finish_reason: 'length' }] }));

  const result = await run({ workspace, home, conversationId: 'stop-abnormal' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('模型没有返回完整回答');
  await expect(readFile(join(workspace, 'stop-ran.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), message).toBe(true);
}