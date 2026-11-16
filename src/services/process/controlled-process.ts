import { spawn, type ChildProcess } from 'node:child_process';

export interface ControlledProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 可选 stdin 内容；省略时子进程的标准输入连接到忽略设备。 */
  stdin?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 各自流最多保留的字节数；超出部分继续消费但不保存。 */
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** 可选合计上限，跨 stdout 与 stderr 共享；省略时两流只受各自上限约束。 */
  combinedLimitBytes?: number;
}

export interface ControlledProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  startFailed: boolean;
}

const DEFAULT_STREAM_LIMIT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 在独立进程组中启动子进程并收集受限输出。启动失败、超时、取消、退出码和截断均作为数据返回，
 * 调用方按业务语义决定抛错或展示。超时与取消对整个进程组发送 SIGKILL，避免留下子进程。
 */
export async function runControlledProcess(
  file: string,
  args: readonly string[],
  options: ControlledProcessOptions,
): Promise<ControlledProcessResult> {
  const { cwd, env, stdin, signal } = options;
  // 已取消时不再启动：调用方可能依赖“未启动”保证，例如审批后取消不应产生副作用。
  if (signal?.aborted) return emptyResult({ cancelled: true });

  const limits = {
    stdout: options.stdoutLimitBytes ?? DEFAULT_STREAM_LIMIT_BYTES,
    stderr: options.stderrLimitBytes ?? DEFAULT_STREAM_LIMIT_BYTES,
    combined: options.combinedLimitBytes ?? Number.POSITIVE_INFINITY,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ControlledProcessResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        detached: true,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env }),
      });
    } catch {
      resolve(emptyResult({ startFailed: true }));
      return;
    }

    let timedOut = false;
    let cancelled = false;
    let startFailed = false;
    const terminate = (): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出。 */ }
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // 监听器注册前可能已经发生取消；事件不会补发，因此显式补一次。
    if (signal?.aborted) onAbort();

    const budget = { remaining: limits.combined };
    const stdout = new StreamCollector(limits.stdout, budget);
    const stderr = new StreamCollector(limits.stderr, budget);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    if (stdin !== undefined) {
      // 子进程可能提前退出导致 EPIPE；stdin 错误不应变成未处理的进程错误。
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin);
    }
    child.once('error', () => { startFailed = true; });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        signal: exitSignal,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        cancelled,
        startFailed,
      });
    });
  });
}

function emptyResult(overrides: Partial<ControlledProcessResult>): ControlledProcessResult {
  return {
    stdout: '', stderr: '', exitCode: null, signal: null,
    stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, startFailed: false,
    ...overrides,
  };
}

interface SharedBudget {
  remaining: number;
}

/** 单流保存器：同时受自身上限与可选共享合计上限约束，超限后仍消费流。 */
class StreamCollector {
  private readonly chunks: Buffer[] = [];
  private saved = 0;
  truncated = false;

  constructor(
    private readonly limitBytes: number,
    private readonly budget: SharedBudget,
  ) {}

  push(chunk: Buffer): void {
    const remaining = Math.max(0, Math.min(this.limitBytes - this.saved, this.budget.remaining));
    if (chunk.length > remaining) this.truncated = true;
    if (remaining === 0) return;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(kept));
    this.saved += kept.length;
    this.budget.remaining -= kept.length;
  }

  text(): string {
    return outputText(this.chunks);
  }
}

/**
 * 无效字节转为文本后再次限定字节量；流式解码丢弃截断处未完成的 UTF-8 字符。
 * 保留与原 Bash 输出收集一致的解码行为，避免截断处出现替换字符。
 */
function outputText(chunks: Buffer[]): string {
  const bytes = Buffer.concat(chunks);
  const textBytes = Buffer.from(new TextDecoder().decode(bytes, { stream: true }));
  return new TextDecoder().decode(textBytes.subarray(0, bytes.length), { stream: true });
}