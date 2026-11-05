import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isWithinWorkspace } from './workspace-files.js';
import { ToolExecutionError } from './tool-registry.js';

export async function prepareBashInput<Input extends { command: string; cwd?: string | undefined }>(workspace: string, input: Input) {
  try {
    const cwd = await realpath(resolve(workspace, input.cwd ?? '.'));
    if (!isWithinWorkspace(workspace, cwd) || !(await stat(cwd)).isDirectory()) throw new Error();
    return { input: { ...input, cwd }, details: { cwd } };
  } catch {
    throw new Error('Bash 工作目录必须是工作区内可访问的实际目录。');
  }
}

export async function runHostBash(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 30_000) {
  signal?.throwIfAborted();
  if (process.platform === 'win32') throw new Error('宿主 Bash 需要支持 POSIX 进程组的系统。');
  try {
    // 审批可能等待很久；已展示的实际目录不能在此期间变成指向其他位置的链接。
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Bash 工作目录在审批后不可用或发生变化，请重新提交调用。');
  }
  signal?.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; truncated: boolean }>((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-c', command], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = (): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出。 */ }
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let savedBytes = 0;
    let truncated = false;
    const collect = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = 65_536 - savedBytes;
      if (chunk.length > remaining) truncated = true;
      const kept = chunk.subarray(0, remaining);
      if (kept.length) destination.push(Buffer.from(kept));
      savedBytes += kept.length;
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    let startFailed = false;
    child.once('error', () => { startFailed = true; });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', terminate);
      const result = { stdout: outputText(stdout), stderr: outputText(stderr), exitCode, signal: exitSignal, truncated };
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut) reject(new ToolExecutionError('Bash 命令执行超时。', result));
      else if (startFailed) reject(new ToolExecutionError('无法启动 Bash 命令。', result));
      else if (exitCode === 0) resolve(result);
      else reject(new ToolExecutionError('Bash 命令执行失败。', result));
    });
  });
}

function outputText(chunks: Buffer[]): string {
  const bytes = Buffer.concat(chunks);
  // 无效字节转为文本后再次限定字节量；流式解码丢弃截断处未完成的 UTF-8 字符。
  const textBytes = Buffer.from(new TextDecoder().decode(bytes, { stream: true }));
  return new TextDecoder().decode(textBytes.subarray(0, bytes.length), { stream: true });
}
