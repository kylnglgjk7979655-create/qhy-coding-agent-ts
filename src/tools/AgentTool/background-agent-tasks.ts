import { randomUUID } from 'node:crypto';

export const MAX_BACKGROUND_AGENT_TASKS = 10;

interface BackgroundAgentTask {
  id: string;
  launchCallId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  report?: string;
  error?: string;
  controller: AbortController;
}

/** 保存当前 CLI 进程中一个主会话的后台任务状态。 */
export class BackgroundAgentTasks {
  private readonly tasks = new Map<string, BackgroundAgentTask>();

  get runningCount(): number {
    return [...this.tasks.values()].filter(({ status }) => status === 'running').length;
  }

  launch(launchCallId: string, run: (signal: AbortSignal) => Promise<string>): { taskId: string; launchCallId: string } {
    if (this.runningCount >= MAX_BACKGROUND_AGENT_TASKS) {
      throw new Error(`后台子 Agent 任务已达上限（${MAX_BACKGROUND_AGENT_TASKS} 个）；请等待任务完成后再启动。`);
    }

    const task: BackgroundAgentTask = {
      id: randomUUID(),
      launchCallId,
      status: 'running',
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    let operation: Promise<string>;
    try {
      operation = run(task.controller.signal);
    } catch (error) {
      task.error = error instanceof Error ? error.message : '后台子 Agent 执行失败。';
      task.status = 'failed';
      return { taskId: task.id, launchCallId };
    }
    void operation.then((report) => {
      task.report = report;
      task.status = 'succeeded';
    }, (error: unknown) => {
      task.error = error instanceof Error ? error.message : '后台子 Agent 执行失败。';
      task.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
    });
    return { taskId: task.id, launchCallId };
  }

  abortAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') task.controller.abort(new Error('CLI 进程正在退出。'));
    }
  }
}

const sessionTasks = new Map<string, BackgroundAgentTasks>();

/** 任务只存活于当前进程，并按主会话隔离。 */
export function backgroundAgentTasksForSession(sessionId: string): BackgroundAgentTasks {
  let tasks = sessionTasks.get(sessionId);
  if (!tasks) {
    tasks = new BackgroundAgentTasks();
    sessionTasks.set(sessionId, tasks);
  }
  return tasks;
}

/** CLI 退出时尽力取消所有会话的后台执行。 */
export function abortAllBackgroundAgentTasks(): void {
  for (const tasks of sessionTasks.values()) tasks.abortAll();
}
