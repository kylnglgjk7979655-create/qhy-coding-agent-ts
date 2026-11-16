import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runCommandHook, type HookInput } from '../src/services/hooks/hook-runner.js';
import { describeHookRun, runHookEvent } from '../src/services/hooks/hook-engine.js';
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