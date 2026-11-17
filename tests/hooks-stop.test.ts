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
  )) as {
    effectiveHistory: Array<{ role: string; content: unknown }>;
    rounds: Array<{ status: string; messages?: Array<{ role: string; content: unknown }> }>;
  };
}

function stopInputs(path: string): Promise<Array<Record<string, unknown>>> {
  return readFile(path, 'utf8').then((text) => text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>));
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

it('Stop 的 stdin 字段与 matcher：阻止理由排在最终回答之后进入续跑请求和有效历史', async () => {
  const answers = ['最终回答一', '续跑回答一', '最终回答二', '续跑回答二'];
  const { workspace, home, fixture } = await setup({
    hooks: {
      Stop: [{ matcher: '^no-such-query$', hooks: [commandHook([
        'cat >> stop-inputs.jsonl',
        "printf '\\n' >> stop-inputs.jsonl",
        `printf '{"decision":"block","reason":"下一轮请修正"}'`,
      ].join('\n'))] }],
    },
  }, (_request, index) => ({ content: answers[index - 1] ?? '多余回答' }));

  const result = await run({
    workspace,
    home,
    input: '第一问\n第二问\n/exit\n',
    conversationId: 'stop-feedback',
  });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(4);

  const inputs = (await readFile(join(workspace, 'stop-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(inputs).toHaveLength(4);
  expect(inputs[0]).toMatchObject({
    session_id: 'stop-feedback',
    cwd: workspace,
    approval_mode: 'human',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '最终回答一',
  });
  expect(inputs.map(({ stop_hook_active }) => stop_hook_active)).toEqual([false, true, false, true]);
  expect(inputs.map(({ last_assistant_message }) => last_assistant_message)).toEqual(answers);
  expect(typeof inputs[0]!.transcript_path).toBe('string');

  const firstContinuation = fixture.requests[1]!;
  const assistantIndex = firstContinuation.messages.findIndex(
    ({ role, content }) => role === 'assistant' && content === '最终回答一',
  );
  const feedbackIndex = firstContinuation.messages.findIndex(
    ({ role, content }) => role === 'user' && content.includes('<hook-feedback event="Stop"'),
  );
  expect(assistantIndex).toBeGreaterThanOrEqual(0);
  expect(feedbackIndex).toBeGreaterThan(assistantIndex);
  expect(firstContinuation.messages[feedbackIndex]!.content).toContain(
    '<hook-feedback event="Stop" hook="Stop:0">\n下一轮请修正\n</hook-feedback>',
  );

  const secondPromptRequest = fixture.requests[2]!;
  const priorFeedbackIndex = secondPromptRequest.messages.findIndex(
    ({ role, content }) => role === 'user' && content.includes('<hook-feedback event="Stop"'),
  );
  const nextPromptIndex = secondPromptRequest.messages.findIndex(
    ({ role, content }) => role === 'user' && content === '第二问',
  );
  expect(priorFeedbackIndex).toBeGreaterThanOrEqual(0);
  expect(nextPromptIndex).toBeGreaterThan(priorFeedbackIndex);

  const stored = await record(home, 'stop-feedback');
  const texts = stored.effectiveHistory.map(messageText);
  expect(texts.at(-1)).toBe('续跑回答二');
  expect(texts.filter((text) => text === '续跑回答一')).toHaveLength(1);
  expect(texts).toContain(
    '<hook-feedback event="Stop" hook="Stop:0">\n下一轮请修正\n</hook-feedback>',
  );
});

it('exit 2 的 stderr 理由作为隐藏反馈；普通 stdout 不注入', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: {
      Stop: [{ hooks: [commandHook([
        'cat >> stop-inputs.jsonl',
        "printf '\\n' >> stop-inputs.jsonl",
        "printf '普通 stdout'",
        "printf 'Stop exit 2 理由' >&2",
        'exit 2',
      ].join('\n'))] }],
    },
  });

  const result = await run({ workspace, home, conversationId: 'stop-exit-two' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Stop exit 2 理由');
  expect(fixture.requests).toHaveLength(2);
  const inputs = await stopInputs(join(workspace, 'stop-inputs.jsonl'));
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toMatchObject({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '已完成',
  });
  expect(inputs[1]).toMatchObject({ stop_hook_active: true, last_assistant_message: '已完成' });

  const stored = await record(home, 'stop-exit-two');
  const texts = stored.effectiveHistory.map(messageText);
  const feedbackIndex = texts.indexOf(
    '<hook-feedback event="Stop" hook="Stop:0">\nStop exit 2 理由\n</hook-feedback>',
  );
  expect(feedbackIndex).toBeGreaterThan(0);
  expect(texts.at(-1)).toBe('已完成');
  expect(texts.slice(feedbackIndex + 1)).toContain('已完成');
  expect(texts.join('\n')).not.toContain('普通 stdout');
});

it('Stop block 后在同一轮次续跑一次：反馈可见，stop_hook_active 先 false 后 true', async () => {
  const blockOnce = [
    'count=$(cat stop-count 2>/dev/null || echo 0)',
    'count=$((count + 1))',
    `printf '%s' "$count" > stop-count`,
    'cat >> stop-inputs.jsonl',
    "printf '\\n' >> stop-inputs.jsonl",
    '[ "$count" -eq 1 ] && printf \'{"decision":"block","reason":"请补充证据"}\'',
  ].join('\n');
  const { workspace, home, fixture } = await setup({
    maxSteps: 4,
    hooks: { Stop: [{ hooks: [commandHook(blockOnce)] }] },
  }, (_request, index) => ({ content: index === 1 ? '第一版回答' : '续跑后的回答' }));

  const result = await run({ workspace, home, conversationId: 'stop-continue' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  const continuation = fixture.requests[1]!;
  expect(continuation.messages).toContainEqual(
    expect.objectContaining({ role: 'user', content: expect.stringContaining('请补充证据') }),
  );
  expect(continuation.messages.filter(({ role }) => role === 'user').map(({ content }) => content))
    .not.toContain('');
  expect(continuation.messages.at(-1)?.content).toContain('<hook-feedback event="Stop"');

  const inputs = await stopInputs(join(workspace, 'stop-inputs.jsonl'));
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toMatchObject({ stop_hook_active: false, last_assistant_message: '第一版回答' });
  expect(inputs[1]).toMatchObject({ stop_hook_active: true, last_assistant_message: '续跑后的回答' });

  const stored = await record(home, 'stop-continue');
  expect(stored.rounds.at(-1)?.status).toBe('succeeded');
  const finalAssistant = stored.effectiveHistory.findLast(({ role }) => role === 'assistant');
  expect(messageText(finalAssistant!)).toContain('续跑后的回答');
  expect(stored.effectiveHistory.some(({ role, content }) =>
    role === 'user' && messageText({ role, content }).includes('请补充证据'))).toBe(true);
});

it('第二次 Stop 仍 block 时只记录日志并结束，不再续跑', async () => {
  const { workspace, home, fixture } = await setup({
    hooks: { Stop: [{ hooks: [commandHook([
      'cat >> stop-inputs.jsonl',
      "printf '\\n' >> stop-inputs.jsonl",
      `printf '{"decision":"block","reason":"仍然阻止"}'`,
    ].join('\n'))] }] },
  }, (_request, index) => ({ content: index === 1 ? '第一版回答' : '第二版回答' }));

  const result = await run({ workspace, home, conversationId: 'stop-twice' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  const inputs = await stopInputs(join(workspace, 'stop-inputs.jsonl'));
  expect(inputs.map((input) => input.stop_hook_active)).toEqual([false, true]);

  const stored = await record(home, 'stop-twice');
  expect(stored.rounds.at(-1)?.status).toBe('succeeded');
  const finalAssistant = stored.effectiveHistory.findLast(({ role }) => role === 'assistant');
  expect(messageText(finalAssistant!)).toContain('第二版回答');
});

it.each([
  ['continue:false', '{"decision":"block","continue":false,"reason":"不再续跑"}'],
  ['preventContinuation', '{"decision":"block","reason":"不再续跑","preventContinuation":true}'],
])('%s 直接结束本轮，不发出续跑请求', async (_label, output) => {
  const { workspace, home, fixture } = await setup({
    hooks: { Stop: [{ hooks: [commandHook(`cat > stop-input.json\nprintf '${output}'`)] }] },
  });

  const result = await run({ workspace, home, conversationId: 'stop-direct-end' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  expect(result.stderr).not.toContain('stdout JSON 无效');
  const input = JSON.parse(await readFile(join(workspace, 'stop-input.json'), 'utf8')) as Record<string, unknown>;
  expect(input.stop_hook_active).toBe(false);

  const stored = await record(home, 'stop-direct-end');
  const finalAssistant = stored.effectiveHistory.findLast(({ role }) => role === 'assistant');
  expect(messageText(finalAssistant!)).toContain('已完成');
});

it('第一次运行已用尽 maxSteps 时不再续跑，总步数不超过上限', async () => {
  const { workspace, home, fixture } = await setup({
    maxSteps: 2,
    hooks: { Stop: [{ hooks: [commandHook([
      'cat >> stop-inputs.jsonl',
      "printf '\\n' >> stop-inputs.jsonl",
      `printf '{"decision":"block","reason":"请继续"}'`,
    ].join('\n'))] }] },
  }, (_request, index) => index === 1
    ? { calls: [{ id: 'read-note', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }] }
    : { content: index === 2 ? '第一版回答' : '不应出现的续跑回答' });
  await writeFile(join(workspace, 'note.txt'), '备注', 'utf8');

  const result = await run({ workspace, home, conversationId: 'stop-step-limit' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(2);
  const inputs = await stopInputs(join(workspace, 'stop-inputs.jsonl'));
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ stop_hook_active: false, last_assistant_message: '第一版回答' });
  expect(result.stdout).not.toContain('不应出现的续跑回答');
});

it('续跑只获得整轮剩余步数，不重新获得完整 maxSteps', async () => {
  const { workspace, home, fixture } = await setup({
    maxSteps: 3,
    hooks: { Stop: [{ hooks: [commandHook([
      "printf '{\"decision\":\"block\",\"reason\":\"请继续\"}'",
    ].join('\n'))] }] },
  }, (_request, index) => index === 1 || index === 3
    ? { calls: [{ id: `read-${index}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }] }
    : { content: index === 2 ? '第一版回答' : '不应出现的续跑回答' });
  await writeFile(join(workspace, 'note.txt'), '备注', 'utf8');

  const result = await run({ workspace, home, conversationId: 'stop-remaining-steps' });

  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('STEP_LIMIT');
  expect(result.stdout).not.toContain('不应出现的续跑回答');
  // 第一次运行用 2 步，续跑只剩 1 步；第三次主请求的工具调用触及上限后停止。
  expect(fixture.requests).toHaveLength(3);
  const stored = await record(home, 'stop-remaining-steps');
  expect(stored.rounds.at(-1)?.status).toBe('failed');
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