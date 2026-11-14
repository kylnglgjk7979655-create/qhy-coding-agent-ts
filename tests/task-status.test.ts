import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSummary } from '../src/services/compact/context-summary.js';
import { BackgroundAgentTasks } from '../src/tools/AgentTool/background-agent-tasks.js';
import type { BackgroundAgentTaskNotification } from '../src/tools/AgentTool/background-agent-tasks.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const summary = '目标：压缩后附加待关注任务状态；约束：只读且不改变任务；结果：状态资料已附加；未完成事项：继续当前任务。';

describe('压缩待关注任务状态', () => {
  let workspace: string;
  let outputDirectory: string;
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  });

  it('只读列出运行中、终态未读取、已读取、失败和取消任务', async () => {
    const tasks = new BackgroundAgentTasks();
    const notifications: BackgroundAgentTaskNotification[] = [];
    tasks.subscribeNotifications((notification) => notifications.push(notification));
    const running = tasks.launch('launch-running', '运行中调查', () => new Promise<string>(() => undefined));
    const succeeded = tasks.launch('launch-succeeded', '成功调查', async () => '成功报告');
    const failed = tasks.launch('launch-failed', '失败调查', async () => {
      throw Object.assign(new Error('失败原因'), { code: 'PROVIDER_ERROR' });
    });
    const cancelled = tasks.launch('launch-cancelled', '取消调查', (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    tasks.cancel(cancelled.taskId);

    await vi.waitFor(() => {
      const statuses = new Map(tasks.pendingStatuses().map(({ taskId, status }) => [taskId, status]));
      expect(statuses.get(succeeded.taskId)).toBe('succeeded');
      expect(statuses.get(failed.taskId)).toBe('failed');
      expect(statuses.get(cancelled.taskId)).toBe('cancelled');
    });

    const pending = tasks.pendingStatuses();
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: running.taskId, description: '运行中调查', status: 'running' }),
      expect.objectContaining({ taskId: succeeded.taskId, description: '成功调查', status: 'succeeded' }),
      expect.objectContaining({ taskId: failed.taskId, description: '失败调查', status: 'failed' }),
      expect.objectContaining({ taskId: cancelled.taskId, description: '取消调查', status: 'cancelled' }),
    ]));
    // 只读列举不领取结果，也不排空通知。
    await vi.waitFor(() => expect(notifications.map(({ taskId }) => taskId)).toEqual(expect.arrayContaining([
      succeeded.taskId, failed.taskId, cancelled.taskId,
    ])));
    expect(tasks.takeNotifications().map(({ taskId }) => taskId)).toEqual(expect.arrayContaining([
      succeeded.taskId, failed.taskId, cancelled.taskId,
    ]));
    expect(tasks.pendingStatuses().find(({ taskId }) => taskId === running.taskId)?.status).toBe('running');

    // 通过原有 status 通路读取终态后不再待关注。
    expect(tasks.get(succeeded.taskId)?.result).toBe('成功报告');
    expect(tasks.pendingStatuses().map(({ taskId }) => taskId)).not.toContain(succeeded.taskId);

    // wait 取得终态同样视为已读取。
    await expect(tasks.wait([cancelled.taskId])).resolves.toMatchObject([{ status: 'cancelled' }]);
    expect(tasks.pendingStatuses().map(({ taskId }) => taskId)).not.toContain(cancelled.taskId);
    // 未查询的失败任务仍在待关注列表。
    expect(tasks.pendingStatuses().map(({ taskId }) => taskId)).toContain(failed.taskId);
  });

  it('终态任务提供结果文件位置，运行中任务不虚构结果位置', async () => {
    const tasks = new BackgroundAgentTasks();
    const running = tasks.launch('launch-running-path', '运行中调查', () => new Promise<string>(() => undefined));
    const succeeded = tasks.launch('launch-succeeded-path', '成功调查', async () => '成功报告');
    await vi.waitFor(() => expect(tasks.pendingStatuses().find(({ taskId }) => taskId === succeeded.taskId)?.status).toBe('succeeded'));

    const pending = tasks.pendingStatuses();
    expect(pending.find(({ taskId }) => taskId === running.taskId)?.resultPath).toBeUndefined();
    // 没有输出目录时终态结果只保存在进程内，不虚构文件路径。
    expect(pending.find(({ taskId }) => taskId === succeeded.taskId)?.resultPath).toBeUndefined();
  });

  it('压缩附件只含任务标识、描述、状态和结果位置，不包含完整报告', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-task-status-workspace-'));
    outputDirectory = await mkdtemp(join(tmpdir(), 'qhy-task-status-output-'));
    const fixture = await startLocalOpenAIModel(
      () => ({ content: '主模型不应被调用' }),
      undefined,
      () => ({ content: summary }),
    );
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };
    const tasks = new BackgroundAgentTasks(outputDirectory);
    const notifications: BackgroundAgentTaskNotification[] = [];
    tasks.subscribeNotifications((notification) => notifications.push(notification));
    let releaseRunning!: () => void;
    const running = tasks.launch('launch-summary-running', '运行中调查', () => new Promise<string>((resolve) => {
      releaseRunning = () => resolve('运行中报告');
    }));
    const succeeded = tasks.launch('launch-summary-succeeded', '成功调查', async () => '完整报告_MARKER');
    const failed = tasks.launch('launch-summary-failed', '失败调查', async () => {
      throw Object.assign(new Error('失败细节_MARKER'), { code: 'PROVIDER_ERROR' });
    });
    await vi.waitFor(() => {
      const statuses = new Map(tasks.pendingStatuses().map(({ taskId, status }) => [taskId, status]));
      expect(statuses.get(succeeded.taskId)).toBe('succeeded');
      expect(statuses.get(failed.taskId)).toBe('failed');
    });
    await vi.waitFor(() => expect(notifications.map(({ taskId }) => taskId)).toEqual(expect.arrayContaining([
      succeeded.taskId, failed.taskId,
    ])));
    const history: ModelMessage[] = [{ role: 'user', content: '压缩前历史' }];
    const result = await generateSummary(config, history, new AbortController().signal, undefined, {
      getTaskStatuses: () => tasks.pendingStatuses(),
    });
    const message = result.compacted[0]!;
    const content = typeof message.content === 'string' ? message.content : '';
    expect(content).toContain('[后台任务状态]');
    expect(content).toContain('task_status');
    expect(content).toContain(running.taskId);
    expect(content).toContain('运行中调查');
    expect(content).toContain('running');
    expect(content).toContain(succeeded.taskId);
    expect(content).toContain('succeeded');
    expect(content).toContain(join(outputDirectory, `${succeeded.taskId}.json`));
    expect(content).toContain(failed.taskId);
    expect(content).toContain('failed');
    expect(content).not.toContain('完整报告_MARKER');
    expect(content).not.toContain('失败细节_MARKER');

    // 生成附件不改变任务状态、通知或结果领取通路。
    expect(tasks.pendingStatuses().find(({ taskId }) => taskId === running.taskId)?.status).toBe('running');
    expect(tasks.takeNotifications().map(({ taskId }) => taskId)).toEqual(expect.arrayContaining([
      succeeded.taskId, failed.taskId,
    ]));
    expect(tasks.get(succeeded.taskId)?.result).toBe('完整报告_MARKER');

    releaseRunning();
    await vi.waitFor(() => expect(tasks.pendingStatuses().find(({ taskId }) => taskId === running.taskId)?.status).toBe('succeeded'));
  });

  it('没有待关注任务时不生成空附件', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-task-status-empty-workspace-'));
    const fixture = await startLocalOpenAIModel(
      () => ({ content: '主模型不应被调用' }),
      undefined,
      () => ({ content: summary }),
    );
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };

    const result = await generateSummary(config, [{ role: 'user', content: '压缩前历史' }], new AbortController().signal, undefined, {
      getTaskStatuses: () => [],
    });
    const message = result.compacted[0]!;
    const content = typeof message.content === 'string' ? message.content : '';
    expect(content).not.toContain('[后台任务状态]');
    expect(content).not.toContain('task_status');
  });
});