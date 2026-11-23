import { spawn, type ChildProcess } from 'node:child_process';

export interface ControlledProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 可选 stdin 内容；省略时子进程的标准输入连接到忽略设备。 */
  stdin?: string | Buffer;
  signal?: AbortSignal;
  /**
   * 仅在启动阶段生效的取消信号：通过各异步检查后不再绑定进程生命周期。
   * 供可切换后台的 Bash 作业使用，审批后、真正 spawn 前的取消不会留下进程。
   */
  startupSignal?: AbortSignal;
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
  /**
   * 子进程退出后回收同进程组的残留成员，并在 completion 解析前等待进程组消失。
   * 用于 Bash 作业：外层 shell 结束但同 PGID 的子进程仍存活时，CLI 退出与停止路径
   * 不会留下无人回收的进程组；沙箱资源也在进程组消失后才释放。
   */
  reapGroupOnExit?: boolean;
  /**
   * 额外保留每路最近输出的滑动窗口，供后台作业实时查看；0 表示不保留。
   * 与最终工具结果的有界保存相互独立：结果仍从流开头截断。
   */
  recentOutputLimitBytes?: number;
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
/** completion 解析前等待被回收进程组消失的上限；SIGKILL 后通常立即完成。 */
const GROUP_EXIT_WAIT_MS = 250;

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

/** 最近输出按路的绝对字节游标；由上一次读取的结果原样传回即可增量读取。 */
export interface OutputCursor {
  stdout: number;
  stderr: number;
}

/** 按游标增量返回的最近输出；`dropped` 表示游标之后已有输出因窗口上限被丢弃。 */
export interface RecentOutput {
  stdout: string;
  stderr: string;
  cursor: OutputCursor;
  dropped: boolean;
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
  /**
   * 读取滑动窗口内的最近输出并推进游标；未启用最近输出窗口时返回空文本。
   * 用于 `/task` 在输出超过有界保存上限后仍能显示最近与实时内容。
   */
  readRecent(cursor: OutputCursor): RecentOutput;
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
  const { cwd, env, stdin, signal, startupSignal } = options;
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

  const idleHandle = (result: ControlledProcessResult): ControlledProcessHandle => ({
    started,
    completion,
    snapshot: () => result,
    terminate: () => undefined,
    // 调用方此时不会交付任务 ID；空的最近输出保持接口形状一致。
    readRecent: (cursor) => ({ stdout: '', stderr: '', cursor, dropped: false }),
  });
  // 已取消时不再启动：调用方可能依赖“未启动”保证，例如审批后取消不应产生副作用。
  if (signal?.aborted || startupSignal?.aborted) {
    resolveStarted(false);
    resolveCompletion(emptyResult({ cancelled: true }));
    return idleHandle(emptyResult({ cancelled: true }));
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
    return idleHandle(emptyResult({ startFailed: true }));
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
    finalResult = currentResult(result.exitCode, result.signal);
    const release = (): void => {
      // 进程组消失后才移除跟踪并解析 completion，保证沙箱资源在进程组收尾后释放。
      activeProcesses.delete(active);
      resolveCompletion(finalResult!);
    };
    if (options.reapGroupOnExit && child.pid !== undefined && processGroupExists(child.pid)) {
      // 退出事件已发送过一次 SIGKILL；close 与 exit 之间新生的同组进程在这里补杀。
      killProcessGroup(child.pid);
      void waitForProcessGroupExit(child.pid).then(release);
      return;
    }
    release();
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
  // 最近输出窗口独立于有界结果保存，用于后台作业在超限后继续显示最近与实时内容。
  const recentLimit = options.recentOutputLimitBytes ?? 0;
  const recentStdout = recentLimit > 0 ? new TailCollector(recentLimit) : undefined;
  const recentStderr = recentLimit > 0 ? new TailCollector(recentLimit) : undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    recentStdout?.push(chunk);
    const exceeded = stdout.push(chunk);
    if (exceeded && options.terminateOnStdoutLimit) terminate();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    recentStderr?.push(chunk);
    stderr.push(chunk);
  });
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
    // 作业模式在外层 shell 退出时回收同 PGID 的残留成员；否则它们会失去可管理的进程组。
    if (options.reapGroupOnExit) killProcessGroup(child.pid);
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
    readRecent: (cursor: OutputCursor): RecentOutput => {
      // 结束时仍可读取窗口，保证接回前台在最后一个轮询与结束之间的输出不会丢失。
      if (recentStdout === undefined || recentStderr === undefined) {
        return { stdout: '', stderr: '', cursor, dropped: false };
      }
      const nextStdout = recentStdout.read(cursor.stdout);
      const nextStderr = recentStderr.read(cursor.stderr);
      return {
        stdout: nextStdout.text,
        stderr: nextStderr.text,
        cursor: { stdout: nextStdout.cursor, stderr: nextStderr.cursor },
        dropped: nextStdout.dropped || nextStderr.dropped,
      };
    },
  };
}

/** 进程组是否仍有成员；仅用于刚回收后的短暂确认。 */
function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待被 SIGKILL 的进程组消失，最多等待一小段；超时由调用方按已记录状态收尾。 */
async function waitForProcessGroupExit(pid: number): Promise<void> {
  const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
 * 最近输出滑动窗口：只保留最新一段字节，供长作业在超过结果保存上限后继续显示。
 * 游标是每路输出的绝对字节偏移；窗口从尾部丢弃时，落后于窗口的读取会收到 dropped。
 */
class TailCollector {
  private readonly chunks: Buffer[] = [];
  private retained = 0;
  private total = 0;

  constructor(private readonly limitBytes: number) {}

  push(chunk: Buffer): void {
    if (this.limitBytes <= 0) return;
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.limitBytes) {
      const excess = this.retained - this.limitBytes;
      const head = this.chunks[0];
      if (head === undefined) break;
      if (head.length <= excess) {
        this.chunks.shift();
        this.retained -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.retained -= excess;
      }
    }
  }

  read(cursor: number): { text: string; cursor: number; dropped: boolean } {
    const start = this.total - this.retained;
    if (cursor >= this.total) return { text: '', cursor: this.total, dropped: false };
    const dropped = cursor < start;
    const from = Math.max(cursor, start);
    const bytes = this.collect(from - start);
    // 窗口起点或游标可能落在多字节字符中间；跳过后续字节，避免输出替换字符。
    let lead = 0;
    while (lead < 3 && lead < bytes.length && (bytes[lead]! & 0xc0) === 0x80) lead += 1;
    const complete = completeUtf8Prefix(bytes.subarray(lead));
    return {
      text: new TextDecoder().decode(bytes.subarray(lead, lead + complete)),
      cursor: from + lead + complete,
      dropped,
    };
  }

  private collect(offset: number): Buffer {
    if (offset === 0) return Buffer.concat(this.chunks, this.retained);
    const parts: Buffer[] = [];
    let position = 0;
    for (const chunk of this.chunks) {
      if (position + chunk.length <= offset) {
        position += chunk.length;
        continue;
      }
      const start = Math.max(0, offset - position);
      parts.push(start === 0 ? chunk : chunk.subarray(start));
      position += chunk.length;
    }
    return Buffer.concat(parts);
  }
}

/** 返回最长的完整 UTF-8 前缀长度；末尾不完整字符留到下一次读取。 */
function completeUtf8Prefix(bytes: Buffer): number {
  const length = bytes.length;
  const windowStart = Math.max(0, length - 4);
  for (let index = length - 1; index >= windowStart; index -= 1) {
    const byte = bytes[index]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return length - index >= needed ? length : index;
  }
  return length;
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