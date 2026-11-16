import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runControlledProcess } from '../src/services/process/controlled-process.js';
import type { ControlledProcessResult } from '../src/services/process/controlled-process.js';

let cwd = '';
const managedPids: number[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-controlled-process-'));
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

interface RunningGroup {
  pending: Promise<ControlledProcessResult>;
  shellPid: number;
  workerPid: number;
}

/** 启动一个带子进程的独立 shell 进程组，并等待 shell 与子进程都已写入 PID。 */
async function startGroup(options: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunningGroup> {
  await writeFile(join(cwd, 'worker.cjs'), "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);");
  const command = `echo $$ > shell.pid; ${process.execPath} worker.cjs & wait`;
  const pending = runControlledProcess(
    'bash',
    ['--noprofile', '--norc', '-c', command],
    {
      cwd,
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  let workerPid = 0;
  await expect.poll(async () => {
    workerPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8').catch(() => '0'));
    return workerPid > 0;
  }, { timeout: 5000, interval: 20 }).toBe(true);
  const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
  managedPids.push(shellPid, workerPid);
  return { pending, shellPid, workerPid };
}

it('分别限制 stdout 与 stderr 保留字节并独立标记截断', async () => {
  const result = await runControlledProcess(
    process.execPath,
    ['-e', "process.stdout.write('甲'.repeat(50)); process.stderr.write('乙'.repeat(50));"],
    { cwd, stdoutLimitBytes: 12, stderrLimitBytes: 9, combinedLimitBytes: 1024 },
  );

  expect(result).toMatchObject({
    exitCode: 0, signal: null, stdoutTruncated: true, stderrTruncated: true, timedOut: false, cancelled: false, startFailed: false,
  });
  expect(result.stdout).toBe('甲'.repeat(4));
  expect(result.stderr).toBe('乙'.repeat(3));
});

it('流未到达各自上限时不标记截断', async () => {
  const result = await runControlledProcess(
    process.execPath,
    ['-e', "process.stdout.write('out'); process.stderr.write('err');"],
    { cwd, stdoutLimitBytes: 3, stderrLimitBytes: 3 },
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err', stdoutTruncated: false, stderrTruncated: false });
});

it('合并上限跨 stdout 与 stderr 共同生效', async () => {
  const result = await runControlledProcess(
    process.execPath,
    ['-e', "process.stdout.write('a'.repeat(8)); process.stderr.write('b'.repeat(8));"],
    { cwd, stdoutLimitBytes: 64, stderrLimitBytes: 64, combinedLimitBytes: 10 },
  );

  const saved = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  expect(saved).toBe(10);
  expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
});

it('通过可选 stdin 向子进程写入数据', async () => {
  const input = 'stdin-payload';
  const result = await runControlledProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    cwd, stdin: input, stdoutLimitBytes: 64,
  });

  expect(result).toMatchObject({ exitCode: 0, stdout: input, stdoutTruncated: false, startFailed: false });
});

it('启动失败作为数据返回而不抛错', async () => {
  const result = await runControlledProcess(join(cwd, 'missing-binary'), [], { cwd });

  // Node 对无法启动的子进程在 close 中给出的退出码因平台/版本而异；调用方应依据 startFailed 判断。
  expect(result).toMatchObject({ stdout: '', stderr: '', signal: null, startFailed: true, timedOut: false, cancelled: false });
});

it('非零退出码原样返回', async () => {
  const result = await runControlledProcess(process.execPath, ['-e', "process.stdout.write('available'); process.stderr.write('problem'); process.exit(7)"], { cwd });

  expect(result).toMatchObject({ exitCode: 7, stdout: 'available', stderr: 'problem', startFailed: false, timedOut: false, cancelled: false });
});

it('超时终止整个进程组并返回超时标记', async () => {
  const { pending, shellPid, workerPid } = await startGroup({ timeoutMs: 2000 });

  const result = await pending;

  expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true, cancelled: false });
  expect(isRunning(shellPid)).toBe(false);
  expect(isRunning(workerPid)).toBe(false);
});

it('取消终止整个进程组并返回取消标记', async () => {
  const controller = new AbortController();
  const { pending, shellPid, workerPid } = await startGroup({ signal: controller.signal });

  controller.abort();
  const result = await pending;

  expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: false, cancelled: true });
  expect(isRunning(shellPid)).toBe(false);
  expect(isRunning(workerPid)).toBe(false);
});

it('启动前已取消的信号不启动子进程', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runControlledProcess(process.execPath, ['-e', "require('node:fs').writeFileSync('should-not-exist.txt', 'x')"], {
    cwd, signal: controller.signal,
  });

  expect(result).toMatchObject({ exitCode: null, signal: null, timedOut: false, cancelled: true, startFailed: false });
  await expect(readFile(join(cwd, 'should-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});