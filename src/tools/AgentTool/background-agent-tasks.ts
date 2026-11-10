import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError, publicError } from '../../utils/errors.js';
import { DEFAULT_CONTEXT } from '../../services/settings/config.js';

export const MAX_BACKGROUND_AGENT_TASKS = 10;

export interface BackgroundAgentTaskResult {
  report: string;
  usage?: { inputTokens: number | undefined; outputTokens: number | undefined };
}

export type BackgroundAgentTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface BackgroundAgentTaskSnapshot {
  taskId: string;
  launchCallId: string;
  description: string;
  status: BackgroundAgentTaskStatus;
  cancellationRequested: boolean;
  result?: string;
  error?: string;
  usage?: BackgroundAgentTaskResult['usage'];
}

export interface BackgroundAgentTaskNotification {
  taskId: string;
  launchCallId: string;
  status: Exclude<BackgroundAgentTaskStatus, 'running'>;
  summary: string;
  finalReply?: string;
  reason?: string;
  outputFilePath?: string;
  usage?: BackgroundAgentTaskResult['usage'];
}

interface BackgroundAgentTask extends BackgroundAgentTaskSnapshot {
  controller: AbortController;
  completion: Promise<void>;
  finish: () => void;
}

/** 保存当前 CLI 进程中一个主会话的后台任务状态。 */
export class BackgroundAgentTasks {
  private readonly tasks = new Map<string, BackgroundAgentTask>();
  private readonly notifications: BackgroundAgentTaskNotification[] = [];
  private readonly retrievedTerminalTasks = new Set<string>();

  constructor(
    private readonly outputDirectory?: string,
    private readonly notificationBudgetTokens = DEFAULT_CONTEXT.capacityTokens - DEFAULT_CONTEXT.answerReserveTokens,
  ) {}

  get runningCount(): number {
    return [...this.tasks.values()].filter(({ status }) => status === 'running').length;
  }

  launch(
    launchCallId: string,
    description: string,
    run: (signal: AbortSignal) => Promise<string | BackgroundAgentTaskResult>,
  ): { taskId: string; launchCallId: string } {
    if (this.runningCount >= MAX_BACKGROUND_AGENT_TASKS) {
      throw new Error(`后台子 Agent 任务已达上限（${MAX_BACKGROUND_AGENT_TASKS} 个）；请等待任务完成后再启动。`);
    }

    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const task: BackgroundAgentTask = {
      taskId: randomUUID(),
      launchCallId,
      description,
      status: 'running',
      cancellationRequested: false,
      controller: new AbortController(),
      completion,
      finish,
    };
    this.tasks.set(task.taskId, task);
    let operation: Promise<string | BackgroundAgentTaskResult>;
    try {
      operation = run(task.controller.signal);
    } catch (error) {
      operation = Promise.reject(error);
    }
    void Promise.resolve(operation).then(async (result) => {
      const resolved = typeof result === 'string' ? { report: result } : result;
      task.result = resolved.report;
      if (resolved.usage) task.usage = resolved.usage;
      task.status = 'succeeded';
      await this.persist(task);
      this.notify(task);
      task.finish();
    }, async (error: unknown) => {
      const code = error instanceof AgentError ? error.code : error instanceof Error && 'code' in error ? error.code : undefined;
      task.status = code === 'TIMEOUT' ? 'timed_out' : task.controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = task.status === 'cancelled'
        ? '后台任务确认因取消请求而终止；既有副作用未回滚。'
        : publicError(error).message;
      await this.persist(task);
      this.notify(task);
      task.finish();
    });
    return { taskId: task.taskId, launchCallId };
  }

  get(taskId: string): BackgroundAgentTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status !== 'running') this.acknowledge(taskId);
    return task ? this.snapshot(task) : undefined;
  }

  /** 取出尚未由 task-manager 查询或等待取得的终态通知。 */
  takeNotifications(): BackgroundAgentTaskNotification[] {
    return this.notifications.splice(0);
  }

  async wait(taskIds: string[]): Promise<Array<BackgroundAgentTaskSnapshot | { taskId: string; status: 'not_found'; error: string }>> {
    const tasks = taskIds.map((taskId) => this.tasks.get(taskId));
    await Promise.all(tasks.filter((task): task is BackgroundAgentTask => task !== undefined)
      .map(({ completion: done }) => done));
    return taskIds.map((taskId) => {
      const task = this.tasks.get(taskId);
      if (task && task.status !== 'running') this.acknowledge(taskId);
      return task ? this.snapshot(task) : { taskId, status: 'not_found', error: '未找到该后台任务。' };
    });
  }

  cancel(taskId: string): { taskId: string; status: BackgroundAgentTaskStatus | 'not_found'; requested: boolean; message: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { taskId, status: 'not_found', requested: false, message: '未找到该后台任务。' };
    if (task.status !== 'running') return { taskId, status: task.status, requested: false, message: '任务已到达终态，未发送取消请求。' };
    task.cancellationRequested = true;
    task.controller.abort(new Error('用户请求取消后台任务。'));
    return { taskId, status: task.status, requested: true, message: '已发送协作式取消请求；只有执行确认结束后才会标记为已取消，既有副作用不会回滚。' };
  }

  abortAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') task.controller.abort(new Error('CLI 进程正在退出。'));
    }
  }

  private snapshot({ controller: _controller, completion: _completion, finish: _finish, ...task }: BackgroundAgentTask): BackgroundAgentTaskSnapshot {
    return { ...task };
  }

  private notify(task: BackgroundAgentTask): void {
    if (this.retrievedTerminalTasks.has(task.taskId)) return;
    const outputFilePath = this.outputDirectory ? join(this.outputDirectory, `${task.taskId}.json`) : undefined;
    const notification: BackgroundAgentTaskNotification = {
      taskId: task.taskId,
      launchCallId: task.launchCallId,
      status: task.status as Exclude<BackgroundAgentTaskStatus, 'running'>,
      summary: task.description,
      ...(task.status === 'succeeded' ? { finalReply: task.result ?? '' } : { reason: task.error ?? '后台任务未成功完成。' }),
      ...(outputFilePath === undefined ? {} : { outputFilePath }),
      ...(task.usage === undefined ? {} : { usage: task.usage }),
    };
    this.notifications.push(limitNotification(notification, this.notificationBudgetTokens));
  }

  private acknowledge(taskId: string): void {
    this.retrievedTerminalTasks.add(taskId);
    for (let index = this.notifications.length - 1; index >= 0; index -= 1) {
      if (this.notifications[index]?.taskId === taskId) this.notifications.splice(index, 1);
    }
  }

  private async persist(task: BackgroundAgentTask): Promise<void> {
    if (!this.outputDirectory) return;
    const directory = this.outputDirectory;
    let temporaryPath: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      temporaryPath = join(directory, `.${task.taskId}.${randomUUID()}.tmp`);
      const { controller: _controller, completion: _completion, finish: _finish, launchCallId: _launchCallId, cancellationRequested: _cancellationRequested, result, ...output } = task;
      await writeFile(temporaryPath, JSON.stringify({ ...output, ...(result === undefined ? {} : { finalReply: result }) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, join(directory, `${task.taskId}.json`));
    } catch {
      // 文件无法写入时仍保留进程内结果，查询和等待仍可取得任务状态。
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

const truncationMarker = '\n\n[通知中的最终回复已截断；完整结果请查询任务或读取输出文件。]';

function estimatedTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}

function truncateText(value: string, budgetTokens: number): string {
  if (estimatedTokens(value) <= budgetTokens) return value;
  const markerTokens = estimatedTokens(truncationMarker);
  const availableTokens = Math.max(0, budgetTokens - markerTokens);
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimatedTokens(characters.slice(0, middle).join('')) <= availableTokens) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('')}${truncationMarker}`;
}

function limitNotification(notification: BackgroundAgentTaskNotification, budgetTokens: number): BackgroundAgentTaskNotification {
  if (notification.finalReply === undefined) return notification;
  const metadata = { ...notification, finalReply: '' };
  const replyBudget = Math.max(0, budgetTokens - estimatedTokens(JSON.stringify(metadata)) - 16);
  return { ...notification, finalReply: truncateText(notification.finalReply, replyBudget) };
}

const sessionTasks = new Map<string, BackgroundAgentTasks>();

/** 任务只存活于当前进程，并按主会话隔离。 */
export function backgroundAgentTasksForSession(sessionId: string, outputDirectory?: string, notificationBudgetTokens?: number): BackgroundAgentTasks {
  let tasks = sessionTasks.get(sessionId);
  if (!tasks) {
    tasks = new BackgroundAgentTasks(outputDirectory, notificationBudgetTokens);
    sessionTasks.set(sessionId, tasks);
  }
  return tasks;
}

/** CLI 退出时尽力取消所有会话的后台执行。 */
export function abortAllBackgroundAgentTasks(): void {
  for (const tasks of sessionTasks.values()) tasks.abortAll();
}
