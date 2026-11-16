import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCommandHook, type HookInput, type HookResult } from '../src/services/hooks/hook-runner.js';
import {
  describeHookRun, hookLogFields, HookInjectionTracker, runHookEvent,
  sessionStartContextMessages, userPromptSubmitContextMessages,
} from '../src/services/hooks/hook-engine.js';
import type { HookCommandRun, HookEventNotification } from '../src/services/hooks/hook-engine.js';
import type { HookCommand, HooksConfig } from '../src/services/hooks/hooks-config.js';

let cwd = '';
const managedPids: number[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-hooks-runner-'));
});

afterEach(async () => {
  for (const pid of managedPids.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 可能未创建进程组。 */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 命令已退出。 */ }
  }
  await rm(cwd, { recursive: true, force: true });
});

function isRunning(pid: number): boolean {
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return status !== '' && !status.startsWith('Z');
}

function hookInput(): HookInput {
  return {
    session_id: 'hook-runner-session',
    transcript_path: join(cwd, 'record.json'),
    cwd,
    approval_mode: 'human',
    hook_event_name: 'Stop',
  };
}

function commandHook(command: string, timeoutMs?: number): HookCommand {
  return { type: 'command', command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/** Hook 命令先写 shell 与后台孙进程 PID，再保持运行；便于断言整棵进程树被终止。 */
function treeCommand(prefix: string, wait: boolean): string {
  return [
    // 不等待的用例会立即退出；先消费 stdin，避免 shell 先于 runner 写入退出而把 EPIPE 误判为启动失败。
    ...(wait ? [] : ['cat > /dev/null']),
    `echo $$ > ${prefix}-shell.pid`,
    `sleep 30 & echo $! > ${prefix}-child.pid`,
    ...(wait ? ['wait'] : []),
  ].join('; ');
}

async function readPid(name: string): Promise<number> {
  return Number(await readFile(join(cwd, name), 'utf8').catch(() => '0'));
}

async function waitForPids(names: readonly string[]): Promise<number[]> {
  let pids: number[] = [];
  await expect.poll(async () => {
    pids = await Promise.all(names.map(readPid));
    return pids.every((pid) => pid > 0);
  }, { timeout: 5000, interval: 20 }).toBe(true);
  managedPids.push(...pids);
  return pids;
}

it('Hook 超时 SIGKILL 整个进程组，孙进程没有残留', async () => {
  const started = performance.now();
  const result = await runCommandHook(
    commandHook(treeCommand('timeout', true)),
    hookInput(),
    { cwd, timeoutMs: 150 },
  );
  const [shellPid, childPid] = await waitForPids(['timeout-shell.pid', 'timeout-child.pid']);

  expect(result).toMatchObject({ outcome: 'non_blocking_error', failureKind: 'timeout' });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(isRunning(shellPid!)).toBe(false);
  expect(isRunning(childPid!)).toBe(false);
});

it('用户取消中止所有正在运行的 Hook，并保留各自的取消结论', async () => {
  const controller = new AbortController();
  const config: HooksConfig = {
    Stop: [{ hooks: [
      commandHook(treeCommand('cancel-a', true)),
      commandHook(treeCommand('cancel-b', true)),
    ] }],
  };
  const pending = runHookEvent(config, 'Stop', hookInput(), { cwd, signal: controller.signal });
  const [shellA, childA, shellB, childB] = await waitForPids([
    'cancel-a-shell.pid', 'cancel-a-child.pid', 'cancel-b-shell.pid', 'cancel-b-child.pid',
  ]);

  controller.abort();
  const result = await pending;

  expect(result.runs.map((run) => run.result.outcome)).toEqual(['cancelled', 'cancelled']);
  expect(isRunning(shellA!)).toBe(false);
  expect(isRunning(childA!)).toBe(false);
  expect(isRunning(shellB!)).toBe(false);
  expect(isRunning(childB!)).toBe(false);
  // 同一个 Hook 结果在 UI/日志中必须标明用户中断，而不是 Hook 故障。
  expect(describeHookRun(result.runs[0]!)).toContain('已取消（用户中断）');
});

it('直接子进程退出后回收后台孙进程，不让继承管道导致挂起', async () => {
  const started = performance.now();
  const result = await runCommandHook(
    commandHook(treeCommand('reap', false)),
    hookInput(),
    { cwd },
  );
  const [shellPid, childPid] = await waitForPids(['reap-shell.pid', 'reap-child.pid']);

  expect(result.outcome).toBe('success');
  // 未启用回收时需要等待后台 sleep 30 退出或默认 60 秒超时。
  expect(performance.now() - started).toBeLessThan(2000);
  expect(isRunning(shellPid!)).toBe(false);
  await expect.poll(() => isRunning(childPid!), { timeout: 3000, interval: 20 }).toBe(false);
});

it('stdin 写入遇到 EPIPE 记为 spawn_error 且不抛出', async () => {
  // shell 显式关闭 stdin 后短暂存活，保证写入必然遇到 EPIPE 而不是竞态。
  const input = { ...hookInput(), prompt: 'x'.repeat(1024 * 1024) };
  const result = await runCommandHook(commandHook('exec 0<&-; sleep 0.2'), input, { cwd });

  expect(result).toMatchObject({ outcome: 'non_blocking_error', failureKind: 'spawn_error', exitCode: 0 });
});

it('单个 Hook 的 timeoutMs 覆盖事件默认值，且各 Hook 独立计时', async () => {
  const config: HooksConfig = {
    Stop: [{ hooks: [
      commandHook('sleep 5', 150),
      commandHook("printf 'ok'"),
    ] }],
  };
  const started = performance.now();
  const result = await runHookEvent(config, 'Stop', hookInput(), { cwd });

  expect(result.runs[0]!.result).toMatchObject({ outcome: 'non_blocking_error', failureKind: 'timeout' });
  expect(result.runs[1]!.result).toMatchObject({ outcome: 'success', stdout: 'ok' });
  // 默认 60 秒；覆盖值生效时整批应在小值内结束。
  expect(performance.now() - started).toBeLessThan(2000);
  expect(describeHookRun(result.runs[0]!)).toContain('Hook 故障：执行超时');
});
function fakeRun(overrides: Partial<HookResult> = {}, order = 0, event: HookCommandRun['event'] = 'Stop'): HookCommandRun {
  return {
    event,
    order,
    matcher: undefined,
    hook: commandHook('true'),
    runId: `${event}-${order}`,
    result: {
      outcome: 'success',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutIsJson: false,
      ...overrides,
    },
  };
}

it('普通 stdout 默认作为 UI 行展示，suppressOutput 只隐藏这一展示', () => {
  expect(describeHookRun(fakeRun({ stdout: '普通输出' }))).toContain('普通输出');
  expect(describeHookRun(fakeRun({ stdout: '普通输出', suppressOutput: true }))).toBeUndefined();
  // systemMessage 是 JSON 字段，不受 suppressOutput 影响。
  const withMessage = fakeRun({ stdout: '普通输出', suppressOutput: true, systemMessage: '给用户' });
  expect(describeHookRun(withMessage)).toContain('给用户');
  expect(describeHookRun(withMessage)).not.toContain('普通输出');
});

it('suppressOutput 不改变 SessionStart 与 UserPromptSubmit 的普通 stdout 注入', () => {
  const tracker = new HookInjectionTracker();
  const sessionStart = fakeRun({ stdout: '启动上下文', suppressOutput: true }, 0, 'SessionStart');
  expect(JSON.stringify(sessionStartContextMessages({ event: 'SessionStart', runs: [sessionStart] }, tracker)))
    .toContain('启动上下文');
  const promptSubmit = fakeRun({ stdout: '提交上下文', suppressOutput: true }, 0, 'UserPromptSubmit');
  expect(JSON.stringify(userPromptSubmitContextMessages({ event: 'UserPromptSubmit', runs: [promptSubmit] }, tracker)))
    .toContain('提交上下文');
});

it('用户可见 UI 行按 500 字符截断', () => {
  const line = describeHookRun(fakeRun({ systemMessage: 'x'.repeat(600) }))!;
  expect(line).toContain(`${'x'.repeat(500)}…`);
  expect(line).not.toContain('x'.repeat(501));
});

it('结构化日志字段只含元数据，不包含 stdout 或 stderr 正文', () => {
  const fields = hookLogFields(fakeRun({
    stdout: 'stdout-secret', stderr: 'stderr-secret',
    stdoutBytes: 13, stderrBytes: 13,
    failureKind: 'exit_code', outcome: 'non_blocking_error', exitCode: 7,
  }, 2));
  expect(fields).toEqual({
    hookEvent: 'Stop',
    hook: 'Stop:2',
    durationMs: 1,
    exitCode: 7,
    outcome: 'non_blocking_error',
    failureKind: 'exit_code',
    stdoutBytes: 13,
    stderrBytes: 13,
  });
  expect(JSON.stringify(fields)).not.toContain('secret');
});

it('每个 Hook 发出 started 与终态通知，回调异常被隔离且不改变结果', async () => {
  const config: HooksConfig = {
    Stop: [{ hooks: [
      commandHook("printf 'ok'"),
      commandHook('exit 7'),
    ] }],
  };
  const notifications: HookEventNotification[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  try {
    const result = await runHookEvent(config, 'Stop', hookInput(), {
      cwd,
      onHookEvent: (notification) => {
        notifications.push(notification);
        throw new Error('观察者异常');
      },
    });
    expect(result.runs.map((run) => run.result.outcome)).toEqual(['success', 'non_blocking_error']);
    // 并行执行下终态到达顺序不固定；每个 Hook 各自必须恰好一个 started 和一个终态。
    expect(notifications.filter(({ hookId }) => hookId === 'Stop:0').map(({ phase }) => phase))
      .toEqual(['started', 'finished']);
    expect(notifications.filter(({ hookId }) => hookId === 'Stop:1').map(({ phase }) => phase))
      .toEqual(['started', 'failed']);
    expect(notifications.find(({ hookId, phase }) => hookId === 'Stop:1' && phase === 'failed')
      ?.run?.result.failureKind).toBe('exit_code');
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Hook 事件通知失败');
  } finally {
    write.mockRestore();
  }
});
