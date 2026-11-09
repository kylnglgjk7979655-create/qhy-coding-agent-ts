import type { SessionRecord } from './conversations.js';
import { deleteWorkspaceFile, snapshotWorkspaceFile, writeWorkspaceFile } from '../../tools/workspace-files.js';
import type { WorkspaceFileSnapshot } from '../../tools/workspace-files.js';

export interface FileRewindItem {
  path: string;
  target: WorkspaceFileSnapshot;
  current?: WorkspaceFileSnapshot;
  inspectionError?: string;
  additions: number;
  deletions: number;
}

export interface FileRewindPlan {
  checkpoint: SessionRecord['checkpoints'][number];
  workspace: string;
  items: FileRewindItem[];
}

export interface FileRewindResult {
  path: string;
  status: 'succeeded' | 'failed';
  message: string;
}

export async function prepareFileRewind(session: SessionRecord, checkpointId: string): Promise<FileRewindPlan> {
  const checkpoint = session.checkpoints.find(({ id }) => id === checkpointId);
  if (!checkpoint) throw new Error('指定的消息检查点不存在。');
  if (!checkpoint.files) throw new Error('消息检查点缺少文件清单，无法安全恢复。');

  // Validate the complete target before inspecting the workspace or allowing any write.
  const targets = checkpoint.files.map(({ path, backupId }) => {
    const backup = session.backups.find(({ id }) => id === backupId);
    if (!backup || backup.id !== backupId || backup.path !== path || (backup.existed && backup.content === undefined)) {
      throw new Error(`检查点备份不完整：${path}。未修改任何文件。`);
    }
    return { path, target: { path, existed: backup.existed, ...(backup.content === undefined ? {} : { content: backup.content }) } };
  });

  const items = await Promise.all(targets.map(async ({ path, target }): Promise<FileRewindItem> => {
    try {
      const current = await snapshotWorkspaceFile(session.workspace, path);
      const [additions, deletions] = lineStats(current, target);
      return { path, target, current, additions, deletions };
    } catch (error) {
      return {
        path,
        target,
        inspectionError: error instanceof Error ? error.message : '无法检查当前文件状态。',
        additions: 0,
        deletions: 0,
      };
    }
  }));
  return { checkpoint, workspace: session.workspace, items };
}

export function fileRewindPlanChanged(before: FileRewindPlan, after: FileRewindPlan): boolean {
  if (before.checkpoint.id !== after.checkpoint.id || before.items.length !== after.items.length) return true;
  return before.items.some((item, index) => {
    const refreshed = after.items[index];
    return !refreshed
      || item.path !== refreshed.path
      || !sameSnapshot(item.target, refreshed.target)
      || item.inspectionError !== refreshed.inspectionError
      || !sameOptionalSnapshot(item.current, refreshed.current);
  });
}

export async function applyFileRewind(plan: FileRewindPlan): Promise<FileRewindResult[]> {
  const results: FileRewindResult[] = [];
  for (const item of plan.items) {
    if (item.current && sameSnapshot(item.current, item.target)) continue;
    try {
      if (item.target.existed) await writeWorkspaceFile(plan.workspace, item.path, item.target.content ?? '');
      else await deleteWorkspaceFile(plan.workspace, item.path);
      results.push({ path: item.path, status: 'succeeded', message: item.target.existed ? '已恢复文件' : '已删除检查点中的新增文件' });
    } catch (error) {
      results.push({ path: item.path, status: 'failed', message: error instanceof Error ? error.message : '文件恢复失败。' });
    }
  }
  return results;
}

export function formatFileRewindPreview(plan: FileRewindPlan): string {
  const changed = plan.items.filter(({ current, inspectionError, target }) => inspectionError || !current || !sameSnapshot(current, target));
  const additions = changed.reduce((total, item) => total + item.additions, 0);
  const deletions = changed.reduce((total, item) => total + item.deletions, 0);
  const removals = changed.filter(({ target }) => !target.existed).length;
  const lines = [
    `恢复目标：消息 ${plan.checkpoint.messageId}（检查点 ${plan.checkpoint.id}）`,
    `改动统计：${changed.length} 个文件，${removals} 个删除项，+${additions} / -${deletions} 行`,
  ];
  if (changed.length === 0) lines.push('没有文件需要恢复。');
  for (const item of changed) {
    if (item.inspectionError) lines.push(`  [无法检查] ${item.path}：${item.inspectionError}`);
    else if (!item.target.existed) lines.push(`  [删除] ${item.path}（+${item.additions} / -${item.deletions} 行）`);
    else lines.push(`  [恢复] ${item.path}（+${item.additions} / -${item.deletions} 行）`);
  }
  return lines.join('\n');
}

function sameOptionalSnapshot(left: WorkspaceFileSnapshot | undefined, right: WorkspaceFileSnapshot | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameSnapshot(left, right);
}

function sameSnapshot(left: WorkspaceFileSnapshot, right: WorkspaceFileSnapshot): boolean {
  return left.existed === right.existed && left.content === right.content;
}

function lineStats(current: WorkspaceFileSnapshot, target: WorkspaceFileSnapshot): [number, number] {
  const currentLines = current.existed ? splitLines(current.content ?? '') : [];
  const targetLines = target.existed ? splitLines(target.content ?? '') : [];
  let prefix = 0;
  while (prefix < currentLines.length && prefix < targetLines.length && currentLines[prefix] === targetLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < currentLines.length - prefix && suffix < targetLines.length - prefix
    && currentLines[currentLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]) suffix++;
  return [targetLines.length - prefix - suffix, currentLines.length - prefix - suffix];
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.replace(/\n$/, '').split('\n');
}
