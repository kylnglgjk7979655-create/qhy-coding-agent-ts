import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseApprovalModeCommand, selectApprovalControl } from '../src/tools/approval-mode.js';
import type { ApprovalControl } from '../src/tools/tool-approval.js';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { readStoredSession } from './helpers/session-store.js';
import { tempDir } from './helpers/temp-dir.js';

let cwd = '';
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;
const children: ChildProcessWithoutNullStreams[] = [];
const env = { TEST_MODE_KEY: 'fake-mode-key' };

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await fixture?.close();
  fixture = undefined;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

function writeCall(id: string, path: string): FixtureToolCall {
  return { id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: `内容-${id}` }) } };
}

async function setup(
  respond: (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>,
  review?: Parameters<typeof startLocalOpenAIModel>[1],
  settings: Record<string, unknown> = {},
) {
  cwd = await tempDir('qhy-approval-mode-');
  fixture = await startLocalOpenAIModel(respond, review);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'mode-fixture', apiKeyEnv: 'TEST_MODE_KEY', baseURL: fixture.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'default', humanTimeoutMs: 5000 }, ...settings,
  }));
  return fixture;
}

async function settingsMode(): Promise<unknown> {
  const settings = JSON.parse(await readFile(join(cwd, '.agent', 'settings.json'), 'utf8')) as { approval?: { mode?: unknown } };
  return settings.approval?.mode;
}

async function sessionRoundModes(): Promise<unknown[]> {
  const root = join(cwd, '.qhy-coding-agents', 'sessions');
  const ids = await readdir(root);
  const modes: unknown[] = [];
  for (const id of ids) {
    const record = await readStoredSession(cwd, id);
    for (const round of record.rounds ?? []) modes.push(round.config?.approval?.mode);
  }
  return modes;
}

function run(input: string, args: string[] = []) {
  return startCLI({ cwd, input, args, env });
}

/** 交互式运行；审批提示只有真实终端才会出现。 */
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

describe('审批模式命令', () => {
  it('显示并切换当前审批模式，非法参数不改变模式，切换不写入 settings 或会话配置', async () => {
    await setup((_request, index) => ({ content: index === 1 ? '收到。' : '不应再次请求' }));
    const result = await run([
      '/permission-mode',
      '/permission-mode auto',
      '/permission-mode',
      '/permission-mode acceptEdits',
      '/permission-mode',
      '/permission-mode default',
      '/permission-mode',
      '你好',
      '/exit',
      '',
    ].join('\n')).done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('当前审批模式：default（人工审批）');
    expect(result.stdout).toContain('当前审批模式：auto（模型审批）');
    expect(result.stdout).toContain('未知审批模式“acceptEdits”');
    expect(result.stdout).toContain('收到。');
    expect(await settingsMode()).toBe('default');
    expect(await sessionRoundModes()).toEqual(['default']);
  });

  it.skipIf(process.platform === 'win32')('等待中的人工审批不被切换自动批准，同轮后续调用使用新模式的模型审批', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [writeCall('first', 'first.txt')] }
      : index === 2
        ? { calls: [writeCall('second', 'second.txt')] }
        : { content: '完成两处写入' }, () => ({ content: 'approve' }));
    const running = runInteractive();
    await running.waitFor('> ');
    running.send('第一次写入\n');
    await running.waitFor('[人工审批 1]');
    await running.waitFor('1. 批准本次');
    expect(running.output()).not.toMatch(/● write_file\(.*· 运行中/u);

    running.send('/permission-mode auto\n');
    await running.waitFor('当前审批模式：auto（模型审批）');
    // 等待中的审批仍按人工模式完成；切换不会替它批准。
    expect(running.output()).toContain('[人工审批 1]');
    expect(fixture!.approvalRequests).toHaveLength(0);
    expect(await readFile(join(cwd, 'first.txt'), 'utf8').catch(() => '')).toBe('');

    running.send('1\r');
    await running.waitFor('完成两处写入');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    // 同一轮中切换之后进入审批的第二次写入改由模型审批，不再出现人工审批 2。
    expect(running.output()).not.toContain('[人工审批 2]');
    expect(fixture!.approvalRequests).toHaveLength(1);
    expect(JSON.parse(fixture!.approvalRequests[0]!.messages.at(-1)!.content)).toMatchObject({
      toolName: 'write_file', input: { path: 'second.txt' },
    });
    expect(await readFile(join(cwd, 'first.txt'), 'utf8')).toBe('内容-first');
    expect(await readFile(join(cwd, 'second.txt'), 'utf8')).toBe('内容-second');
    expect(await settingsMode()).toBe('default');
  });

  it.skipIf(process.platform === 'win32')('等待中的模型审批不被切换改判人工，之后进入审批的调用使用 default', async () => {
    let reviewEntered!: () => void;
    let releaseReview!: () => void;
    const entered = new Promise<void>((resolve) => { reviewEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseReview = resolve; });
    await setup((_request, index) => index === 1
      ? { calls: [writeCall('pending', 'pending.txt')] }
      : index === 2
        ? { calls: [writeCall('after', 'after.txt')] }
        : { content: '完成两处写入' }, async () => {
      reviewEntered();
      await gate;
      return { content: 'approve' };
    }, { approval: { mode: 'auto', humanTimeoutMs: 5000 } });
    const running = runInteractive();
    await running.waitFor('> ');
    running.send('第一次写入\n');
    await Promise.race([entered, running.done.then((result) => {
      throw new Error(`等待模型审批前进程退出 ${result.code}：${running.output()}`);
    })]);
    expect(running.output()).not.toContain('[人工审批');
    expect(fixture!.approvalRequests).toHaveLength(1);

    running.send('/permission-mode default\n');
    await running.waitFor('当前审批模式：default（人工审批）');
    // 已进入模型审查的调用继续由模型决定，不会改派人工。
    expect(running.output()).not.toContain('[人工审批');
    releaseReview();

    // 之后进入审批的第二次写入改用人工审批，编号从 1 开始。
    await running.waitFor('[人工审批 1]');
    await running.waitFor('1. 批准本次');
    expect(running.output()).not.toContain('[人工审批 2]');
    expect(fixture!.approvalRequests).toHaveLength(1);
    await expect(readFile(join(cwd, 'pending.txt'), 'utf8')).resolves.toBe('内容-pending');
    expect(await readFile(join(cwd, 'after.txt'), 'utf8').catch(() => '')).toBe('');

    running.send('1\r');
    await running.waitFor('完成两处写入');
    running.end('/exit\n');
    const result = await running.done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await readFile(join(cwd, 'after.txt'), 'utf8')).toBe('内容-after');
    expect(await settingsMode()).toBe('auto');
  });

  it.skipIf(process.platform === 'win32')('重启并恢复同一会话后使用 settings 模式，进程内的切换不持久化', async () => {
    await setup((request) => {
      const last = request.messages.at(-1);
      if (last?.role !== 'user') return { content: '写入完成' };
      return last.content.includes('再次写入')
        ? { calls: [writeCall('resumed', 'note-resumed.txt')] }
        : { calls: [writeCall('restart', 'note.txt')] };
    }, () => ({ content: 'approve' }));
    const first = await run('/permission-mode auto\n第一次写入\n/exit\n', ['--conversation-id', 'restarted']).done;
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).not.toContain('人工审批');
    expect(fixture!.approvalRequests).toHaveLength(1);
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('内容-restart');
    expect(await settingsMode()).toBe('default');

    const second = runInteractive(['--conversation-id', 'restarted']);
    await second.waitFor('> ');
    second.send('再次写入\n');
    await second.waitFor('[人工审批 1]');
    await second.waitFor('1. 批准本次');
    second.send('1\r');
    await second.waitFor('写入完成');
    second.end('/exit\n');
    const result = await second.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    // 新进程恢复同一会话后重新从 settings 取得 default，必须人工审批。
    expect(second.output()).toContain('[人工审批 1]');
    expect(await readFile(join(cwd, 'note-resumed.txt'), 'utf8')).toBe('内容-resumed');
    expect(await settingsMode()).toBe('default');
  });

  it('支持与 Claude Code 同名的 --permission-mode 启动参数，且仅作用于当前进程', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [writeCall('flag', 'flag.txt')] }
      : { content: '写入完成' }, () => ({ content: 'approve' }));
    const result = await run('写入文件\n/exit\n', ['--permission-mode', 'auto']).done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(fixture!.approvalRequests).toHaveLength(1);
    expect(await readFile(join(cwd, 'flag.txt'), 'utf8')).toBe('内容-flag');
    expect(await settingsMode()).toBe('default');
  });

  it('非法启动参数会报告配置错误且不启动会话', async () => {
    await setup(() => ({ content: '不应执行' }));
    const result = await run('/exit\n', ['--permission-mode', 'acceptEdits']).done;

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--permission-mode');
  });
});

describe('审批模式命令解析', () => {
  it('只把查看、default 与 auto 识别为有效命令', () => {
    expect(parseApprovalModeCommand('/permission-mode')).toEqual({});
    expect(parseApprovalModeCommand('  /permission-mode auto  ')).toEqual({ mode: 'auto' });
    expect(parseApprovalModeCommand('/permission-mode default')).toEqual({ mode: 'default' });
    expect(parseApprovalModeCommand('/permission-mode acceptEdits')).toEqual({ invalid: 'acceptEdits' });
    expect(parseApprovalModeCommand('/permission-mode auto extra')).toEqual({ invalid: 'auto extra' });
    expect(parseApprovalModeCommand('/permission-modex')).toBeUndefined();
    expect(parseApprovalModeCommand('/permissions')).toBeUndefined();
    expect(parseApprovalModeCommand('你好')).toBeUndefined();
  });

  it('default 优先人工控制，auto 只使用通用控制', () => {
    const human: ApprovalControl = async () => 'approve';
    const generic: ApprovalControl = async () => 'deny';
    expect(selectApprovalControl('default', generic, human)).toBe(human);
    expect(selectApprovalControl('default', generic, undefined)).toBe(generic);
    expect(selectApprovalControl('default', undefined, undefined)).toBeUndefined();
    expect(selectApprovalControl('auto', generic, human)).toBe(generic);
    expect(selectApprovalControl('auto', undefined, human)).toBeUndefined();
  });
});
