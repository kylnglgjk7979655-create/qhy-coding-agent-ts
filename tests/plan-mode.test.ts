import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { readStoredSession } from './helpers/session-store.js';
import { tempDir } from './helpers/temp-dir.js';

let cwd = '';
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;
const children: ChildProcessWithoutNullStreams[] = [];
const env = { TEST_PLAN_KEY: 'fake-plan-key' };

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await fixture?.close();
  fixture = undefined;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

async function setup(
  respond: (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>,
  settings: Record<string, unknown> = {},
) {
  cwd = await tempDir('qhy-plan-mode-');
  fixture = await startLocalOpenAIModel(respond, () => ({ content: 'approve' }));
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'plan-fixture', apiKeyEnv: 'TEST_PLAN_KEY', baseURL: fixture.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'default', humanTimeoutMs: 5000 }, ...settings,
  }));
  return fixture;
}

function run(input: string, args: string[] = []) {
  return startCLI({ cwd, input, args, env });
}

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

/** 交互式运行；等待提示栏中出现目标文本后再继续。 */
function runInteractive(args: string[] = []) {
  let output = '';
  const waiters = new Set<() => void>();
  const running = startCLI({ cwd, args, pty: true, env }, (stdout) => {
    output = stdout;
    for (const notify of waiters) notify();
  });
  children.push(running.child);
  const waitFor = async (text: string): Promise<void> => {
    if (output.includes(text)) return;
    let notify!: () => void;
    const arrived = new Promise<void>((done) => {
      notify = () => { if (output.includes(text)) done(); };
      waiters.add(notify);
    });
    try {
      await Promise.race([arrived, running.done.then((result) => {
        throw new Error(`等待“${text}”前进程退出 ${result.code}：${output}`);
      })]);
    } finally {
      waiters.delete(notify);
    }
  };
  return { ...running, waitFor, output: () => output };
}

function toolNames(request: FixtureRequest | undefined): string[] {
  return (request?.tools ?? []).map(({ function: definition }) => definition.name).sort();
}

describe('plan 审批模式', () => {
  it.skipIf(process.platform === 'win32')('Shift+Tab 按 default → auto → plan → default 循环并更新提示栏', async () => {
    await setup(() => ({ content: '不应请求模型' }));
    const running = runInteractive();
    await running.waitFor('[default（人工审批）] > ');

    running.send('\x1b[Z');
    await running.waitFor('当前审批模式：auto（模型审批）。');
    await running.waitFor('[auto（模型审批）] > ');

    running.send('\x1b[Z');
    await running.waitFor('当前审批模式：plan（只读）。');
    await running.waitFor('[plan（只读）] > ');

    running.send('\x1b[Z');
    await running.waitFor('当前审批模式：default（人工审批）。');
    await running.waitFor('[default（人工审批）] > ');

    running.end('/exit\n');
    const result = await running.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(fixture!.requests).toHaveLength(0);
  });

  it('plan 只向模型公布 Read、Glob 与 Grep，并把只读对话保存到会话记录', async () => {
    await setup((request) => toolNames(request).join(',') === 'Glob,Grep,Read'
      ? { content: '只读调查完成。' }
      : { content: `意外工具：${toolNames(request).join(',')}` });
    await writeFile(join(cwd, 'note.txt'), 'plan 可读内容');

    const result = await run([
      '/permission-mode plan',
      '调查工作区',
      '/exit',
      '',
    ].join('\n')).done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('当前审批模式：plan（只读）。');
    expect(result.stdout).toContain('只读调查完成。');
    expect(toolNames(fixture!.requests[0])).toEqual(['Glob', 'Grep', 'Read']);

    const session = await readStoredSession(cwd);
    const users = session.transcript.filter(({ role }) => role === 'user');
    expect(users.at(-1)?.content).toBe('调查工作区');
    expect(session.transcript.some(({ role, content }) => role === 'assistant'
      && JSON.stringify(content).includes('只读调查完成。'))).toBe(true);
    expect(session.rounds?.at(-1)?.config?.approval?.mode).toBe('default');
  });

  it('plan 可以连续进行两轮只读对话，每轮都只公布只读工具', async () => {
    await setup((_request, index) => index === 1
      ? { content: '第一轮只读回答。' }
      : index === 2 ? { content: '第二轮只读回答。' } : { content: '意外额外请求。' });

    const result = await run('/permission-mode plan\n第一个问题\n第二个问题\n/exit\n').done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('第一轮只读回答。');
    expect(result.stdout).toContain('第二轮只读回答。');
    expect(fixture!.requests).toHaveLength(2);
    for (const request of fixture!.requests) expect(toolNames(request)).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('plan 对话写入会话记录后，可在新进程继续同一段只读对话', async () => {
    await setup((_request, index) => index === 1
      ? { content: '第一轮只读回答。' }
      : index === 2 ? { content: '续聊只读回答。' } : { content: '意外额外请求。' });
    const first = await run('/permission-mode plan\n第一问\n/exit\n', ['--conversation-id', 'plan-resume']).done;
    expect(first.code, first.stdout + first.stderr).toBe(0);

    const second = await run('/permission-mode plan\n继续问\n/exit\n', ['--conversation-id', 'plan-resume']).done;

    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('续聊只读回答。');
    const resumed = fixture!.requests.at(-1)!;
    expect(toolNames(resumed)).toEqual(['Glob', 'Grep', 'Read']);
    expect(resumed.messages.some(({ role, content }) => role === 'assistant'
      && JSON.stringify(content).includes('第一轮只读回答。'))).toBe(true);
  });

  it('plan 中 Glob 与 Grep 正常工作，Read 的 deny 规则仍然优先', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        call('glob', 'Glob', { pattern: '*.txt', path: 'notes' }),
        call('grep', 'Grep', { pattern: '允许', path: 'notes' }),
        call('read', 'Read', { file_path: 'notes/note.txt' }),
      ] }
      : { content: '只读规则检查完成。' }, { permissions: { deny: ['Read'] } });
    await mkdir(join(cwd, 'notes'), { recursive: true });
    await writeFile(join(cwd, 'notes', 'note.txt'), '允许读取');

    const result = await run('/permission-mode plan\n检查规则\n/exit\n').done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('只读规则检查完成。');
    const toolResults = fixture!.requests.at(-1)!.messages
      .filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
    const resultFor = (id: string): { is_error: boolean; output?: Record<string, unknown>; error?: { code: string } } =>
      JSON.parse(toolResults.find(({ tool_call_id }) => tool_call_id === id)!.content);
    expect(resultFor('glob')).toMatchObject({ is_error: false, output: { paths: ['notes/note.txt'] } });
    expect(resultFor('grep')).toMatchObject({ is_error: false, output: {
      matches: [expect.objectContaining({ path: 'notes/note.txt', text: '允许读取' })],
    } });
    expect(resultFor('read')).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    expect(fixture!.approvalRequests).toHaveLength(0);
  });

  it('plan 中即使配置允许也拒绝写入、命令与其他工具，只读调用继续工作', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        call('read', 'Read', { file_path: 'note.txt' }),
        call('write-old', 'write_file', { path: 'blocked-old.txt', content: '不应写入' }),
        call('write-new', 'Write', { file_path: 'blocked-new.txt', content: '不应写入' }),
        call('bash', 'Bash', { command: "printf 'ran' > bash-ran.txt" }),
        call('todo', 'TodoWrite', { todos: [{ content: '不应记录', status: 'pending' }] }),
        call('runtime', 'runtimeInfo', {}),
      ] }
      : { content: '只读检查完成。' }, {
      permissions: { allow: ['Read', 'Write', 'Bash(printf:*)', 'TodoWrite', 'RuntimeInfo'] },
    });
    await writeFile(join(cwd, 'note.txt'), '允许读取');

    const result = await run('/permission-mode plan\n检查\n/exit\n').done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('只读检查完成。');
    for (const name of ['blocked-old.txt', 'blocked-new.txt', 'bash-ran.txt']) {
      await expect(readFile(join(cwd, name), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const toolResults = fixture!.requests.at(-1)!.messages
      .filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
    expect(JSON.parse(toolResults.find(({ tool_call_id }) => tool_call_id === 'read')!.content))
      .toEqual({ is_error: false, output: expect.objectContaining({ content: '允许读取' }) });
    for (const id of ['write-old', 'write-new', 'bash', 'todo', 'runtime']) {
      expect(JSON.parse(toolResults.find(({ tool_call_id }) => tool_call_id === id)!.content))
        .toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    }
    expect(fixture!.approvalRequests).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('切到 plan 后，进入审批时已等待的写入即使获批也不执行', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [call('pending-write', 'write_file', { path: 'pending.txt', content: '不应写入' })] }
      : { content: '切换后拒绝写入。' });
    const running = runInteractive();
    await running.waitFor('[default（人工审批）] > ');
    running.send('写入文件\n');
    await running.waitFor('[人工审批 1] write_file');

    running.send('/permission-mode plan\n');
    await running.waitFor('当前审批模式：plan（只读）。');
    running.send('1\r');
    await running.waitFor('切换后拒绝写入。');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    await expect(readFile(join(cwd, 'pending.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const toolResult = fixture!.requests.at(-1)!.messages
      .find(({ role }) => role === 'tool') as unknown as { content: string };
    expect(JSON.parse(toolResult.content)).toMatchObject({
      is_error: true,
      error: { code: 'PERMISSION_DENIED' },
    });
  });

  it.skipIf(process.platform === 'win32')('plan 的只读范围审批交给人工，而不使用 settings 的模型审批', async () => {
    const outside = await tempDir('qhy-plan-outside-');
    await writeFile(join(outside, 'secret.txt'), '工作区外内容');
    await setup((_request, index) => index === 1
      ? { calls: [call('outside-read', 'Read', { file_path: join(outside, 'secret.txt') })] }
      : { content: '外部读取完成。' }, { approval: { mode: 'auto', humanTimeoutMs: 5000 } });

    const running = runInteractive();
    await running.waitFor('[auto（模型审批）] > ');
    running.send('/permission-mode plan\n');
    await running.waitFor('[plan（只读）] > ');
    running.send('读取外部文件\n');
    await running.waitFor('[人工审批 1] Read');
    expect(fixture!.approvalRequests).toHaveLength(0);

    running.send('1\r');
    await running.waitFor('外部读取完成。');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    const toolResult = fixture!.requests.at(-1)!.messages
      .find(({ role }) => role === 'tool') as unknown as { content: string };
    expect(JSON.parse(toolResult.content)).toEqual({
      is_error: false,
      output: expect.objectContaining({ content: '工作区外内容' }),
    });
    expect(fixture!.approvalRequests).toHaveLength(0);
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('plan 切回 auto 后恢复模型审批，不再询问人工', async () => {
    const outside = await tempDir('qhy-plan-auto-');
    await writeFile(join(outside, 'secret.txt'), '切回后的外部内容');
    await setup((_request, index) => index === 1
      ? { calls: [call('outside-read', 'Read', { file_path: join(outside, 'secret.txt') })] }
      : index === 2 ? { content: '切回 auto 后读取完成。' } : { content: '意外额外请求。' });

    const running = runInteractive();
    await running.waitFor('[default（人工审批）] > ');
    running.send('/permission-mode plan\n');
    await running.waitFor('[plan（只读）] > ');
    running.send('/permission-mode auto\n');
    await running.waitFor('[auto（模型审批）] > ');
    running.send('读取外部文件\n');
    await running.waitFor('切回 auto 后读取完成。');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(running.output()).not.toContain('[人工审批');
    expect(fixture!.approvalRequests).toHaveLength(1);
    const toolResult = fixture!.requests.at(-1)!.messages
      .find(({ role }) => role === 'tool') as unknown as { content: string };
    expect(JSON.parse(toolResult.content)).toEqual({
      is_error: false,
      output: expect.objectContaining({ content: '切回后的外部内容' }),
    });
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('plan 期间暂停全部命令型 Hook，退出后下一轮恢复原模式 Hook 行为', async () => {
    const marker = (text: string) => ({
      type: 'command' as const,
      command: `printf '${text}' >> hook-events.txt`,
    });
    await setup((request, index) => {
      if (index === 1) {
        expect(toolNames(request)).toEqual(['Glob', 'Grep', 'Read']);
        return { calls: [call('plan-read', 'Read', { file_path: 'note.txt' })] };
      }
      if (index === 2) return { content: 'plan 轮完成。' };
      if (index === 3) {
        expect(toolNames(request)).toEqual(expect.arrayContaining(['Read', 'Write', 'Bash']));
        return { calls: [call('default-read', 'Read', { file_path: 'note.txt' })] };
      }
      return { content: 'default 轮完成。' };
    }, {
      hooks: {
        SessionStart: [{ hooks: [marker('t')] }],
        UserPromptSubmit: [{ hooks: [marker('u')] }],
        PreToolUse: [{ hooks: [marker('p')] }],
        PostToolUse: [{ hooks: [marker('q')] }],
        Stop: [{ hooks: [marker('s')] }],
      },
    });
    await writeFile(join(cwd, 'note.txt'), '可读内容');

    const running = runInteractive(['--permission-mode', 'plan', '--trust-hooks']);
    await running.waitFor('[plan（只读）] > ');
    running.send('第一轮\n');
    await running.waitFor('plan 轮完成。');
    running.send('/permission-mode default\n');
    await running.waitFor('[default（人工审批）] > ');
    running.send('第二轮\n');
    await running.waitFor('default 轮完成。');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    // startup 与 plan 轮都不执行 Hook；切回 default 后只需一次用户提交即可恢复全部事件。
    expect(await readFile(join(cwd, 'hook-events.txt'), 'utf8')).toBe('upqs');
  });

  it('plan 模式拒绝 --smoke-tool，避免强制调用未公布的 read_file', async () => {
    await setup(() => ({ content: '不应请求模型' }));

    const result = await run('', ['--smoke-tool', '--permission-mode', 'plan']).done;

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--smoke-tool');
    expect(fixture!.requests).toHaveLength(0);
  });
});
