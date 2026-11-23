import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ToolExecutionError } from '../tool-registry.js';
import type { ControlledProcessResult } from '../../services/process/controlled-process.js';
import type { BashRunResult } from './host-bash.js';
import type { PlannedBashExecution } from './sandbox-bash.js';

/**
 * Bash 作业状态。终态沿用受控进程的判定：
 * `timed_out` 只会在作业处于前台且用完前台时限时出现，后台运行不计时。
 */
export type BashJobStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export interface BashJobSnapshot {
  taskId: string;
  command: string;
  status: BashJobStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  sandboxed: boolean;
  notice?: string;
  /** 终态诊断（例如代理拒绝汇总）；运行中或没有诊断时省略。 */
  diagnostics?: string;
  backgrounded: boolean;
  startedAt: number;
}

export interface BashJobNotification {
  conversationId: string;
  taskId: string;
  status: Exclude<BashJobStatus, 'running'>;
  exitCode: number | null;
  signal: string | null;
}

/** 直接启动或从前台切换得到的后台作业标识；两种入口返回相同形状。 */
export interface BashJobStarted {
  taskId: string;
  status: 'running';
  detached?: true;
  hint: string;
  /** 本次作业实际的执行模式；后台启动同样保留沙箱状态。 */
  sandboxed: boolean;
  /** 沙箱不可用、豁免获准等执行说明；后台启动结果不能丢弃该说明。 */
  notice?: string;
}

export interface BashJobLaunch {
  command: string;
  execution: PlannedBashExecution;
  /** 前台累计时限；后台运行期间不计入。 */
  timeoutMs: number;
  /** 执行计划的沙箱状态与说明；运行中的快照与启动结果都使用它。 */
  sandboxed: boolean;
  notice?: string;
}

interface Job {
  taskId: string;
  command: string;
  execution: PlannedBashExecution;
  sandboxed: boolean;
  notice?: string;
  status: BashJobStatus;
  exitCode: number | null;
  signal: string | null;
  finalResult?: BashRunResult;
  finalError?: string | undefined;
  finalDiagnostics?: string | undefined;
  startedAt: number;
  backgrounded: boolean;
  /** 任务 ID 交付前已取消：收尾时不再发出结束通知，作业也不在池中。 */
  abandoned: boolean;
  /** 未耗尽的前台时限；进入后台时暂停累计。 */
  remainingMs: number;
  foregroundSince?: number | undefined;
  timer?: NodeJS.Timeout | undefined;
  timedOut: boolean;
  stopRequested: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  detach?: (() => void) | undefined;
}

const startedHint = 'Bash 作业在后台运行；使用 /tasks 查看作业，使用 /task <任务 ID> 接回前台。避免重复启动同一命令。';
/** 最近输出窗口已丢弃较早内容时的明确提示；只显示一次，避免每个轮询重复刷屏。 */
const recentOutputTruncatedNotice = '\n（输出超过保留上限，较早部分已丢弃，以下为最近输出）\n';
const notificationListeners = new Set<(notification: BashJobNotification) => void>();

/** 订阅本次 CLI 进程内所有会话的后台 Bash 作业结束通知。 */
export function subscribeBashJobNotifications(listener: (notification: BashJobNotification) => void): () => void {
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

function notify(notification: BashJobNotification): void {
  for (const listener of notificationListeners) {
    try { listener(notification); } catch { /* 通知只用于展示，不影响作业收尾。 */ }
  }
}

/** 保存当前 CLI 进程中一个对话的 Bash 作业；作业归属于启动它的对话。 */
export class BashJobs {
  private readonly jobs = new Map<string, Job>();
  private foreground: { taskId: string } | undefined;

  constructor(private readonly conversationId: string) {}

  /**
   * 前台运行：普通调用等待命令结束后返回结果；用户按 Ctrl+B 时立即返回任务 ID，
   * 进程继续在后台运行。前台时限只在此方法等待期间计时。
   */
  async runForeground(launch: BashJobLaunch, signal?: AbortSignal): Promise<BashRunResult | BashJobStarted> {
    const job = this.createJob(launch, false);
    this.claimForeground(job);
    this.startForegroundTimer(job);
    try {
      const outcome = await this.waitForForeground(job, signal);
      this.pauseForeground(job);
      this.clearForeground(job);
      // 交付边界：结束与取消在同一事件循环交错时，只要取消先被观察到就不交付结果。
      // 取消早于结果交付意味着模型不会收到任务 ID，作业必须终止并从池中移除。
      if (outcome === 'aborted' || signal?.aborted === true) {
        await this.abandon(job);
        throw signal?.reason;
      }
      if (outcome === 'detached') {
        // 切换与命令自然结束相邻发生时，进程可能已经结束；此时按普通结果交付，
        // 不能再声称作业仍在运行，否则模型会引用一个已停止的任务。
        if (job.status !== 'running') return this.foregroundResult(job);
        // 进程保持运行，工具调用只交付一次带任务 ID 的结果；沙箱状态与说明随结果交付。
        job.backgrounded = true;
        return { ...this.startedResult(job), detached: true };
      }
      return this.foregroundResult(job);
    } finally {
      this.clearForeground(job);
    }
  }

  /**
   * 直接在后台启动：进程成功启动且任务 ID 仍可交付时返回；
   * 启动失败按普通调用失败返回，启动回执期间取消则终止自有进程组并移除作业。
   */
  async startBackground(launch: BashJobLaunch, signal?: AbortSignal): Promise<BashJobStarted> {
    const job = this.createJob(launch, true);
    const started = await this.waitForStartup(job.execution.started, signal);
    if (started === 'aborted') {
      await this.abandon(job);
      signal?.throwIfAborted();
      // 取消已由上面的检查抛出；此分支仅防御信号与竞速状态不一致。
      throw signal?.reason ?? new Error('Bash 作业启动已取消。');
    }
    if (!started) {
      await job.done;
      this.jobs.delete(job.taskId);
      throw new ToolExecutionError(
        job.finalError ?? '无法启动 Bash 命令。',
        job.finalResult ?? { stdout: '', stderr: '', exitCode: null, signal: null, truncated: false, sandboxed: false },
      );
    }
    // 启动回执与任务 ID 交付之间仍可能取消；未交付的作业不能留在池中继续运行。
    if (signal?.aborted) {
      await this.abandon(job);
      signal.throwIfAborted();
    }
    return this.startedResult(job);
  }

  /** 启动成功后的统一结果；保留与前台结果一致的沙箱状态与说明。 */
  private startedResult(job: Job): BashJobStarted {
    return {
      taskId: job.taskId,
      status: 'running',
      hint: startedHint,
      sandboxed: job.sandboxed,
      ...(job.notice === undefined ? {} : { notice: job.notice }),
    };
  }

  /** 当前对话的作业，按启动时间排序；终态作业仍保留输出直到 CLI 退出。 */
  list(): BashJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((first, second) => first.startedAt - second.startedAt)
      .map((job) => this.snapshot(job));
  }

  get(taskId: string): BashJobSnapshot | undefined {
    const job = this.jobs.get(taskId);
    return job === undefined ? undefined : this.snapshot(job);
  }

  /** 停止运行中的作业并返回可展示结果；终态作业不发送信号。 */
  stop(taskId: string): string {
    const job = this.jobs.get(taskId);
    if (!job) return `未找到 Bash 作业：${taskId}`;
    if (job.status !== 'running') return `作业 ${taskId} 已结束（${job.status}），未发送停止请求。`;
    job.stopRequested = true;
    job.execution.terminate();
    return `已停止 Bash 作业：${taskId}`;
  }

  /** Ctrl+B：把当前前台的 Bash 作业切到后台，返回被切换的任务 ID。 */
  detachForeground(): { taskId: string } | undefined {
    const foreground = this.foreground;
    if (!foreground) return undefined;
    const job = this.jobs.get(foreground.taskId);
    if (!job || job.status !== 'running' || job.detach === undefined) return undefined;
    // 立即清空挂点：同一前台作业不会因连续按键再次报告“已切换到后台”。
    const detach = job.detach;
    job.detach = undefined;
    detach();
    return { taskId: job.taskId };
  }

  /**
   * 接回前台：先显示保留的最近输出，再按固定间隔继续显示新增输出。
   * 未结束的作业使用剩余前台时限；直接后台启动的作业首次接回获得完整时限。
   */
  async attach(
    taskId: string,
    options: { signal: AbortSignal; write: (text: string) => void },
  ): Promise<
    { kind: 'ended' | 'detached' | 'aborted'; snapshot: BashJobSnapshot }
    | { kind: 'not_found' }
    | { kind: 'busy'; snapshot: BashJobSnapshot }
  > {
    const job = this.jobs.get(taskId);
    if (!job) return { kind: 'not_found' };
    if (job.status !== 'running') return { kind: 'ended', snapshot: this.snapshot(job) };
    if (this.foreground !== undefined) {
      // 调用方应等当前前台作业结束后再重试；这里不能报告为 ended。
      return { kind: 'busy', snapshot: this.snapshot(job) };
    }

    // 使用最近输出窗口与字节游标：超过有界保存上限后仍能显示最近内容与后续实时输出。
    let cursor = { stdout: 0, stderr: 0 };
    let droppedNoticeShown = false;
    const writeRecent = (): void => {
      const recent = job.execution.readRecent(cursor);
      cursor = recent.cursor;
      if (recent.dropped && !droppedNoticeShown) {
        droppedNoticeShown = true;
        options.write(recentOutputTruncatedNotice);
      }
      if (recent.stdout !== '') options.write(recent.stdout);
      if (recent.stderr !== '') options.write(recent.stderr);
    };
    // 先显示后台期间保留的最近输出；随后只追加新增部分，避免重复打印。
    writeRecent();
    const interval = setInterval(writeRecent, 100);

    this.claimForeground(job);
    this.startForegroundTimer(job);
    try {
      const outcome = await this.waitForForeground(job, options.signal);
      if (outcome === 'aborted') {
        job.stopRequested = true;
        job.execution.terminate();
        await job.done;
      }
      clearInterval(interval);
      writeRecent();
      this.pauseForeground(job);
      this.clearForeground(job);
      // 切换与结束相邻发生时，进程可能已在切走前结束；以终态报告，避免重复承诺“仍在后台运行”。
      return {
        kind: outcome === 'detached' && job.status !== 'running' ? 'ended' : outcome,
        snapshot: this.snapshot(job),
      };
    } finally {
      clearInterval(interval);
      this.clearForeground(job);
    }
  }

  /**
   * 等待当前前台作业结束、被 Ctrl+B 切走或因取消信号中止。
   * 前后台入口共用同一竞速逻辑，区别只在调用方如何处理每种结果。
   */
  private waitForForeground(job: Job, signal: AbortSignal | undefined): Promise<'ended' | 'detached' | 'aborted'> {
    let abortHandler: (() => void) | undefined;
    const aborted: Promise<'aborted'> = signal === undefined
      ? new Promise<'aborted'>(() => undefined)
      : new Promise<'aborted'>((resolve) => {
        abortHandler = () => resolve('aborted');
        signal.addEventListener('abort', abortHandler, { once: true });
        // 监听器注册前可能已经取消；事件不会补发。
        if (signal.aborted) abortHandler();
      });
    const detached = new Promise<'detached'>((resolve) => {
      job.detach = () => resolve('detached');
    });
    return Promise.race([
      job.done.then(() => 'ended' as const),
      detached,
      aborted,
    ]).finally(() => {
      if (abortHandler !== undefined) signal?.removeEventListener('abort', abortHandler);
      job.detach = undefined;
    });
  }

  /**
   * 取消发生在任务 ID 交付之前：终止自有进程组、等待收尾并从作业池移除。
   * 作业从未交付给模型，不能留下可被 `/tasks` 领取的条目；已交付的作业不经过这里。
   */
  private async abandon(job: Job): Promise<void> {
    job.abandoned = true;
    job.stopRequested = true;
    this.pauseForeground(job);
    this.clearForeground(job);
    job.execution.terminate();
    await this.waitForCleanup(job.done);
    this.jobs.delete(job.taskId);
  }

  /** 等待启动回执；取消先到时立即返回，避免回执延迟把已取消的作业带进交付。 */
  private async waitForStartup(started: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean | 'aborted'> {
    if (signal === undefined) return started;
    let abortHandler: (() => void) | undefined;
    try {
      return await Promise.race([
        started,
        new Promise<'aborted'>((resolve) => {
          abortHandler = () => resolve('aborted');
          signal.addEventListener('abort', abortHandler, { once: true });
          // 监听器注册前可能已经取消；事件不会补发。
          if (signal.aborted) abortHandler();
        }),
      ]);
    } finally {
      if (abortHandler !== undefined) signal.removeEventListener('abort', abortHandler);
    }
  }

  /** 收尾等待有上限：逃出进程组仍持有管道的后代不能阻塞取消路径，exit 清理兜底。 */
  private async waitForCleanup(done: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** CLI 退出时终止所有仍在运行的作业，并等待进程组收尾与沙箱资源清理。 */
  async abortAll(): Promise<void> {
    const running = [...this.jobs.values()].filter(({ status }) => status === 'running');
    for (const job of running) {
      job.stopRequested = true;
      job.execution.terminate();
    }
    // 收尾等待有上限：逃出进程组仍持有管道的后代不能阻塞 CLI 退出，受控进程的 exit 清理兜底。
    await Promise.race([
      Promise.allSettled(running.map(({ done }) => done)),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  }

  private createJob(launch: BashJobLaunch, backgrounded: boolean): Job {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const job: Job = {
      taskId: randomUUID(),
      command: launch.command,
      execution: launch.execution,
      sandboxed: launch.sandboxed,
      ...(launch.notice === undefined ? {} : { notice: launch.notice }),
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      backgrounded,
      abandoned: false,
      remainingMs: launch.timeoutMs,
      timedOut: false,
      stopRequested: false,
      done,
      resolveDone,
    };
    this.jobs.set(job.taskId, job);
    void job.execution.completion.then(
      (controlled) => this.finishJob(job, controlled),
      () => this.finishJob(job, {
        stdout: '', stderr: '', exitCode: null, signal: null,
        stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, startFailed: true, stdinFailed: false,
      }),
    );
    return job;
  }

  private finishJob(job: Job, controlled: ControlledProcessResult): void {
    if (job.status !== 'running') return;
    job.exitCode = controlled.exitCode;
    job.signal = controlled.signal;
    job.finalResult = job.execution.result(controlled);
    job.finalDiagnostics = job.execution.diagnostics();
    job.status = this.terminalStatus(job, controlled);
    job.finalError = job.status === 'succeeded'
      ? undefined
      : job.stopRequested || job.status === 'cancelled'
        ? 'Bash 作业已停止。'
        // 前台时限由作业层计时，受控进程本身没有 timedOut 标记。
        : job.status === 'timed_out'
          ? 'Bash 命令执行超时。'
          : job.execution.failureMessage(controlled);
    this.pauseForeground(job);
    // 接回前台时由 /task 自己报告最终状态，不再重复发送后台结束通知。
    const wasForeground = this.foreground !== undefined && this.foreground.taskId === job.taskId;
    this.clearForeground(job);
    job.resolveDone();
    // 交付前取消的作业已从池中移除，不再向用户发出结束通知。
    if (job.abandoned) return;
    // 进程从未启动时由 startBackground 直接返回失败结果，不产生“作业已结束”通知。
    if (job.backgrounded && !wasForeground && !controlled.startFailed) {
      notify({
        conversationId: this.conversationId,
        taskId: job.taskId,
        status: job.status,
        exitCode: job.exitCode,
        signal: job.signal,
      });
    }
  }

  private terminalStatus(job: Job, controlled: ControlledProcessResult): Exclude<BashJobStatus, 'running'> {
    if (job.timedOut || controlled.timedOut) return 'timed_out';
    if (job.stopRequested || controlled.cancelled) return 'cancelled';
    if (controlled.startFailed) return 'failed';
    return controlled.exitCode === 0 ? 'succeeded' : 'failed';
  }

  private snapshot(job: Job): BashJobSnapshot {
    // 运行中读取实时快照；结束后使用最终结果，避免清理阶段丢失输出。
    const controlled = job.finalResult === undefined ? job.execution.snapshot() : undefined;
    // 运行中的作业同样保留计划里的执行模式与说明，避免首次接回/列表丢失沙箱状态。
    const result = job.finalResult ?? {
      stdout: controlled!.stdout,
      stderr: controlled!.stderr,
      exitCode: null,
      signal: null,
      truncated: controlled!.stdoutTruncated || controlled!.stderrTruncated,
      sandboxed: job.sandboxed,
      ...(job.notice === undefined ? {} : { notice: job.notice }),
    };
    return {
      taskId: job.taskId,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      sandboxed: result.sandboxed,
      ...(result.notice === undefined ? {} : { notice: result.notice }),
      ...(job.finalDiagnostics === undefined ? {} : { diagnostics: job.finalDiagnostics }),
      backgrounded: job.backgrounded,
      startedAt: job.startedAt,
    };
  }

  private foregroundResult(job: Job): BashRunResult {
    if (job.finalResult === undefined) {
      throw new ToolExecutionError('Bash 作业结果不可用。', undefined);
    }
    if (job.status === 'succeeded') return job.finalResult;
    throw new ToolExecutionError(job.finalError ?? 'Bash 命令执行失败。', job.finalResult);
  }

  private claimForeground(job: Job): void {
    // registry 以独占方式调度 Bash；同一时刻只应有一个前台作业。
    this.foreground = { taskId: job.taskId };
  }

  private clearForeground(job: Job): void {
    if (this.foreground !== undefined && this.foreground.taskId === job.taskId) this.foreground = undefined;
  }

  private startForegroundTimer(job: Job): void {
    if (job.status !== 'running' || job.timer !== undefined) return;
    job.foregroundSince = performance.now();
    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.timedOut = true;
      job.execution.terminate();
    }, job.remainingMs);
  }

  /** 切到后台或作业结束时暂停前台计时，把已用时间从剩余预算中扣除。 */
  private pauseForeground(job: Job): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.foregroundSince !== undefined) {
      job.remainingMs = Math.max(0, job.remainingMs - (performance.now() - job.foregroundSince));
      job.foregroundSince = undefined;
    }
  }
}

const sessionJobs = new Map<string, BashJobs>();

/** Bash 作业只存活于当前进程，并按对话隔离；切换对话后切回仍可找到原作业。 */
export function bashJobsForSession(conversationId: string): BashJobs {
  let jobs = sessionJobs.get(conversationId);
  if (!jobs) {
    jobs = new BashJobs(conversationId);
    sessionJobs.set(conversationId, jobs);
  }
  return jobs;
}

/** CLI 正常退出时终止所有会话中仍在运行的 Bash 作业并等待收尾。 */
export async function abortAllBashJobs(): Promise<void> {
  await Promise.all([...sessionJobs.values()].map((jobs) => jobs.abortAll()));
}
