import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isWithinWorkspace } from '../workspace-files.js';
import { ToolExecutionError } from '../tool-registry.js';
import { analyzeBashCommand } from './bash-policy.js';

export interface BashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  /** 本次调用是否在操作系统沙箱内执行；沙箱关闭或不可用时为 false。 */
  sandboxed: boolean;
}

export interface BashProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  sandboxed: boolean;
  /** 无法启动子进程时的提示；宿主与沙箱使用不同措辞。 */
  startFailureMessage?: string;
}

export async function prepareBashInput<Input extends { command: string; cwd?: string | undefined }>(workspace: string, input: Input) {
  try {
    const requestedCwd = input.cwd ?? '.';
    const cwd = await realpath(resolve(workspace, requestedCwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error();
    const analysis = analyzeBashCommand(input.command);
    return { input: { ...input, cwd, requestedCwd, approvedCwd: cwd }, details: {
      cwd,
      bashCommands: JSON.stringify(analysis.commands),
      bashRequiresApproval: String(analysis.requiresApproval || !isWithinWorkspace(resolve(workspace), cwd)),
    } };
  } catch {
    throw new Error('Bash 命令或工作目录无效、无法可靠解析，或无法访问。');
  }
}

export async function verifyBashWorkingDirectory(workspace: string, requestedCwd: string, approvedCwd: string): Promise<void> {
  const current = await realpath(resolve(workspace, requestedCwd));
  if (current !== approvedCwd || !(await stat(current)).isDirectory()) {
    throw new Error('Bash 工作目录在审批期间发生变化，请重新提交调用。');
  }
}

/** 宿主 Bash 沿用当前用户环境启动独立 shell；结果显式标记未隔离。 */
export async function runHostBash(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<BashRunResult> {
  if (process.platform === 'win32') throw new Error('宿主 Bash 需要支持 POSIX 进程组的系统。');
  return runBashProcess('bash', ['--noprofile', '--norc', '-c', command], {
    cwd,
    sandboxed: false,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });
}

/**
 * 启动一次 Bash 子进程并收集受限输出；宿主与沙箱执行共用进程组、超时和取消语义。
 * 调用方负责在审批后确认 cwd 未变化。
 */
export async function runBashProcess(
  file: string,
  args: string[],
  options: BashProcessOptions,
): Promise<BashRunResult> {
  const { cwd, env, signal, timeoutMs = 30_000, sandboxed } = options;
  signal?.throwIfAborted();
  if (process.platform === 'win32') throw new Error('宿主 Bash 需要支持 POSIX 进程组的系统。');
  try {
    // 审批可能等待很久；已展示的实际目录不能在此期间变成指向其他位置的链接。
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Bash 工作目录在审批后不可用或发生变化，请重新提交调用。');
  }
  signal?.throwIfAborted();
  return new Promise<BashRunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      ...(env === undefined ? {} : { env }),
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
      const result: BashRunResult = {
        stdout: outputText(stdout), stderr: outputText(stderr), exitCode, signal: exitSignal, truncated, sandboxed,
      };
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut) reject(new ToolExecutionError('Bash 命令执行超时。', result));
      else if (startFailed) reject(new ToolExecutionError(options.startFailureMessage ?? '无法启动 Bash 命令。', result));
      else if (exitCode === 0) resolve(result);
      else if (sandboxed && /operation not permitted/iu.test(result.stderr)) {
        reject(new ToolExecutionError('Bash 命令被沙箱策略拦截（Operation not permitted），而非命令本身错误。', result));
      } else reject(new ToolExecutionError('Bash 命令执行失败。', result));
    });
  });
}

function outputText(chunks: Buffer[]): string {
  const bytes = Buffer.concat(chunks);
  // 无效字节转为文本后再次限定字节量；流式解码丢弃截断处未完成的 UTF-8 字符。
  const textBytes = Buffer.from(new TextDecoder().decode(bytes, { stream: true }));
  return new TextDecoder().decode(textBytes.subarray(0, bytes.length), { stream: true });
}
