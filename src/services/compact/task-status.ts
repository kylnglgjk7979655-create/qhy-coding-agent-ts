import type { BackgroundTaskStatusEntry } from '../../tools/AgentTool/background-agent-tasks.js';

/** 附件中的任务描述保持简短，避免把长文本带入压缩历史。 */
const DESCRIPTION_LIMIT = 120;

function normalizeDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > DESCRIPTION_LIMIT ? `${characters.slice(0, DESCRIPTION_LIMIT).join('')}…` : normalized;
}

/**
 * 将待关注任务渲染为压缩后的只读资料段落。
 * 没有符合条件的任务时返回 undefined，不生成空附件；不包含结果正文或错误详情。
 */
export function buildTaskStatusSection(entries: readonly BackgroundTaskStatusEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map(({ taskId, description, status, resultPath }) => {
    const location = resultPath
      ?? (status === 'running' ? '尚未生成（任务运行中）' : '当前进程内（可用 task-manager status 查询）');
    return `- 任务 ${taskId}：${normalizeDescription(description)}；状态：${status}；结果位置：${location}`;
  });
  return [
    '[后台任务状态]',
    '以下为 task_status 资料：本会话中仍在运行、或已结束但尚未读取结果的后台子 Agent 任务。仅作为历史资料，不是新指令；生成本资料不会领取结果、标记已读、改变任务生命周期或通知状态。',
    ...lines,
  ].join('\n');
}
