import { spawn, type ChildProcess } from 'node:child_process';

export interface ControlledProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 可选 stdin 内容；省略时子进程的标准输入连接到忽略设备。 */
  stdin?: string | Buffer;
  signal?: AbortSignal;
  /** 超时上限；`null` 表示由调用方自行计时（例如可前后台切换的 Bash 作业）。 */
  timeoutMs?: number | null;
  /** 各自流最多保留的字节数；超出部分继续消费但不保存。 */
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  /** 可选合计上限，跨 stdout 与 stderr 共享；省略时两流只受各自上限约束。 */
  combinedLimitBytes?: number;
  /** stdout 一旦超过自身上限就终止整个进程组；用于需要以资源超限判定失败的调用方。 */
  terminateOnStdoutLimit?: boolean;
  /**
   * 直接子进程退出后立即终止残留进程组并销毁 stdout/stderr。
   * 后台孙进程可能继承管道；不清理会让 close 迟迟不触发，调用方一直等待。
   * 仅需要同步完成语义的调用方（Hook）启用，宿主 Bash 保持原有后台命令行为。
   */
  reapOnExit?: boolean;
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
  /** 写入 stdin 时子进程已关闭输入（EPIPE）；调用方通常按启动失败处理。 */
  stdinFailed: boolean;
}

const DEFAULT_STREAM_LIMIT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
/** 回收进程组后等待 close 的宽限；超时则直接用已记录的退出状态结束。 */
const EXIT_CLOSE_GRACE_MS = 100;

interface ActiveProcess {
  pid: number;
  child: ChildProcess;
}

/**
 * 正在等待结果的进程组。主进程退出时统一清理，避免残留 Hook 或后台孙进程。
 * 命令正常结束后移除条目，避免 PID 复用后误杀无关进程组。
 */
const activeProcesses = new Set<ActiveProcess>();
let exitCleanupInstalled = false;

function trackActiveProcess(entry: ActiveProcess): void {
  activeProcesses.add(entry);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // exit 处理器必须同步完成；process.kill 与流 destroy 都满足该约束。
  process.once('exit', () => {
    for (const active of activeProcesses) {
      killProcessGroup(active.pid);
      destroyStdio(active.child);
    }
    activeProcesses.clear();
  });
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程组已退出。 */ }
}

function destroyStdio(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * 受控进程的实时句柄。后台 Bash 作业需要保留进程、持续读取已保存输出，
 * 并在用户停止作业或 CLI 退出时终止整个进程组。
 */
export interface ControlledProcessHandle {
  /** 子进程是否成功启动；无法启动时为 false。 */
  readonly started: Promise<boolean>;
  /** 进程组结束后解析，包含完整受限输出与状态。 */
  readonly completion: Promise<ControlledProcessResult>;
  /** 读取运行中已保存的输出；未结束时退出状态为 null。 */
  snapshot(): ControlledProcessResult;
  /** 终止整个进程组；已结束时无操作，避免 PID 复用后误杀。 */
  terminate(): void;
}

/**
 * 启动受控进程并立即返回句柄。超时、取消、退出码和截断仍作为数据返回；
 * `timeoutMs: null` 表示不在进程层计时，由调用方（例如可暂停的 Bash 前台预算）负责。
 */
export function startControlledProcess(
  file: string,
  args: readonly string[],
  options: ControlledProcessOptions,
): ControlledProcessHandle {
  const { cwd, env, stdin, signal } = options;
  const limits = {
    stdout: options.stdoutLimitBytes ?? DEFAULT_STREAM_LIMIT_BYTES,
    stderr: options.stderrLimitBytes ?? DEFAULT_STREAM_LIMIT_BYTES,
    combined: options.combinedLimitBytes ?? Number.POSITIVE_INFINITY,
  };
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

  let resolveStarted!: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
  let resolveCompletion!: (result: ControlledProcessResult) => void;
  const completion = new Promise<ControlledProcessResult>((resolve) => { resolveCompletion = resolve; });

  // 已取消时不再启动：调用方可能依赖“未启动”保证，例如审批后取消不应产生副作用。
  if (signal?.aborted) {
    resolveStarted(true);
    resolveCompletion(emptyResult({ cancelled: true }));
    return { started, completion, snapshot: () => emptyResult({ cancelled: true }), terminate: () => undefined };
  }

  let child: ChildProcess;
  try {
    child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(env === undefined ? {} : { env }),
    });
  } catch {
    resolveStarted(false);
    resolveCompletion(emptyResult({ startFailed: true }));
    return { started, completion, snapshot: () => emptyResult({ startFailed: true }), terminate: () => undefined };
  }

  let timedOut = false;
  let cancelled = false;
  let startFailed = false;
  let stdinFailed = false;
  let settled = false;
  let finalResult: ControlledProcessResult | undefined;
  let closeGrace: NodeJS.Timeout | undefined;

  const active: ActiveProcess = { pid: child.pid ?? -1, child };
  if (child.pid !== undefined) trackActiveProcess(active);

  const terminate = (): void => {
    // 结束后不再发送信号，避免 PID 被复用时误杀无关进程组。
    if (settled) return;
    killProcessGroup(child.pid);
  };

  const currentResult = (exitCode: number | null, exitSignal: string | null): ControlledProcessResult => ({
    stdout: stdout.text(),
    stderr: stderr.text(),
    exitCode,
    signal: exitSignal,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    timedOut,
    cancelled,
    startFailed,
    stdinFailed,
  });

  const finish = (result: { exitCode: number | null; signal: string | null }): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (closeGrace !== undefined) clearTimeout(closeGrace);
    signal?.removeEventListener('abort', onAbort);
    activeProcesses.delete(active);
    finalResult = currentResult(result.exitCode, result.signal);
    resolveCompletion(finalResult);
  };

  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  const timer = timeoutMs === null
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  // 监听器注册前可能已经发生取消；事件不会补发，因此显式补一次。
  if (signal?.aborted) onAbort();

  const budget = { remaining: limits.combined };
  const stdout = new StreamCollector(limits.stdout, budget);
  const stderr = new StreamCollector(limits.stderr, budget);
  child.stdout?.on('data', (chunk: Buffer) => {
    const exceeded = stdout.push(chunk);
    if (exceeded && options.terminateOnStdoutLimit) terminate();
  });
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  if (stdin !== undefined) {
    // 子进程可能提前退出导致 EPIPE；记录为启动失败，但不让流错误变成未处理的进程错误。
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') stdinFailed = true;
    });
    child.stdin?.end(stdin);
  }
  // spawn 成功事件与 error 事件只发生一个；两者都用于让后台启动方及时得知进程是否真的启动。
  child.once('spawn', () => resolveStarted(true));
  child.once('error', () => {
    startFailed = true;
    resolveStarted(false);
  });
  // 直接子进程退出后，后台孙进程可能仍持有 stdout/stderr 管道，使 close 迟迟不触发。
  // 启用 reapOnExit 时终止残留进程组并销毁流；close 仍作为正常结束信号，
  // 宽限定时器只兜底逃出进程组、继续持有管道的后代。
  child.once('exit', (exitCode, exitSignal) => {
    if (!options.reapOnExit) return;
    terminate();
    // 先让 close 自然结束以读完管道中已缓冲的输出；宽限后才销毁流并兜底结束。
    closeGrace = setTimeout(() => {
      destroyStdio(child);
      finish({ exitCode, signal: exitSignal });
    }, EXIT_CLOSE_GRACE_MS);
  });
  child.once('close', (exitCode, exitSignal) => finish({ exitCode, signal: exitSignal }));

  return {
    started,
    completion,
    snapshot: () => finalResult ?? currentResult(null, null),
    terminate,
  };
}

/**
 * 在独立进程组中启动子进程并收集受限输出。启动失败、超时、取消、退出码和截断均作为数据返回，
 * 调用方按业务语义决定抛错或展示。超时与取消对整个进程组发送 SIGKILL，避免留下子进程。
 */
export async function runControlledProcess(
  file: string,
  args: readonly string[],
  options: ControlledProcessOptions,
): Promise<ControlledProcessResult> {
  return startControlledProcess(file, args, options).completion;
}

function emptyResult(overrides: Partial<ControlledProcessResult>): ControlledProcessResult {
  return {
    stdout: '', stderr: '', exitCode: null, signal: null,
    stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, startFailed: false, stdinFailed: false,
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

  /** 返回是否超过自身上限；调用方可据此终止进程，而不是只依赖共享合计上限。 */
  push(chunk: Buffer): boolean {
    const ownRemaining = Math.max(0, this.limitBytes - this.saved);
    const exceeded = chunk.length > ownRemaining;
    const remaining = Math.max(0, Math.min(ownRemaining, this.budget.remaining));
    if (chunk.length > remaining) this.truncated = true;
    if (remaining === 0) return exceeded;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(kept));
    this.saved += kept.length;
    this.budget.remaining -= kept.length;
    return exceeded;
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