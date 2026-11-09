import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface WorkspaceFileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

export type WorkspaceFileBaselines = Map<string, WorkspaceFileSnapshot>;

// 同一进程内的所有 Agent 共用写入门闩，避免检查基线与落盘之间被另一个受控写入插入。
class WorkspaceWriteLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

const workspaceWriteLock = new WorkspaceWriteLock();

export function isWithinWorkspace(workspace: string, target: string): boolean {
  const pathFromWorkspace = relative(workspace, target);
  return pathFromWorkspace === ''
    || (!pathFromWorkspace.startsWith(`..${sep}`) && pathFromWorkspace !== '..' && !isAbsolute(pathFromWorkspace));
}

async function resolveReadTarget(workspace: string, requestedPath: string): Promise<string> {
  const candidate = resolve(workspace, requestedPath);
  const canonicalTarget = await realpath(candidate);
  if (!isWithinWorkspace(workspace, canonicalTarget)) throw new Error('越出工作区');
  return canonicalTarget;
}

async function resolveWriteTarget(workspace: string, requestedPath: string): Promise<string> {
  const candidate = resolve(workspace, requestedPath);
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    try {
      await lstat(candidate);
      throw new Error('无法解析目标符号链接');
    } catch (statError) {
      if (!(statError instanceof Error) || !('code' in statError) || statError.code !== 'ENOENT') throw statError;
    }
    const canonicalParent = await realpath(dirname(candidate));
    canonicalTarget = resolve(canonicalParent, basename(candidate));
  }
  if (!isWithinWorkspace(workspace, canonicalTarget)) throw new Error('越出工作区');
  return canonicalTarget;
}

export async function readWorkspaceFile(
  workspace: string,
  requestedPath: string,
  baselines?: WorkspaceFileBaselines,
): Promise<string> {
  try {
    const target = await resolveReadTarget(workspace, requestedPath);
    const content = await readFile(target, 'utf8');
    baselines?.set(relative(workspace, target), { path: relative(workspace, target), existed: true, content });
    return content;
  } catch {
    throw new Error('无法访问文件：目标必须存在且位于工作区内。');
  }
}

export async function writeControlledWorkspaceFile(
  workspace: string,
  requestedPath: string,
  content: string,
  baselines: WorkspaceFileBaselines,
  beforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>,
  onBackupFailure?: (path: string) => void,
): Promise<void> {
  await workspaceWriteLock.run(async () => {
    let target: string;
    try {
      target = await resolveWriteTarget(workspace, requestedPath);
      const path = relative(workspace, target);
      let current: WorkspaceFileSnapshot;
      try { current = { path, existed: true, content: await readFile(target, 'utf8') }; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') current = { path, existed: false };
        else throw error;
      }
      const baseline = baselines.get(path);
      if (current.existed && !baseline) throw new Error(`写入冲突：尚未读取文件“${path}”，请先重新读取。`);
      if (baseline && (baseline.existed !== current.existed || baseline.content !== current.content)) {
        throw new Error(`写入冲突：文件“${path}”已在读取后变化，请重新读取后再写入。`);
      }
      if (!current.existed && baseline?.existed) throw new Error(`写入冲突：文件“${path}”已在读取后删除，请重新读取后再写入。`);
      if (beforeWrite) {
        try { await beforeWrite(current); }
        catch { onBackupFailure?.(path); }
      }
      await writeFile(target, content, current.existed ? 'utf8' : { encoding: 'utf8', flag: 'wx' });
      baselines.set(path, { path, existed: true, content });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('写入冲突：')) throw error;
      throw new Error('无法写入文件：父目录必须存在且目标必须位于工作区内。');
    }
  });
}

export async function snapshotWorkspaceFile(workspace: string, requestedPath: string): Promise<WorkspaceFileSnapshot> {
  const target = await resolveWriteTarget(workspace, requestedPath);
  const path = relative(workspace, target);
  try {
    return { path, existed: true, content: await readFile(target, 'utf8') };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { path, existed: false };
    throw new Error('无法读取文件检查点：目标必须位于工作区内且可访问。');
  }
}

export async function writeWorkspaceFile(
  workspace: string,
  requestedPath: string,
  content: string,
  beforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>,
  onBackupFailure?: (path: string) => void,
): Promise<void> {
  try {
    const target = await resolveWriteTarget(workspace, requestedPath);
    if (beforeWrite) {
      const path = relative(workspace, target);
      try {
        let snapshot: WorkspaceFileSnapshot;
        try {
          snapshot = { path, existed: true, content: await readFile(target, 'utf8') };
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') snapshot = { path, existed: false };
          else throw error;
        }
        await beforeWrite(snapshot);
      } catch {
        onBackupFailure?.(path);
      }
    }
    await writeFile(target, content, 'utf8');
  } catch {
    throw new Error('无法写入文件：父目录必须存在且目标必须位于工作区内。');
  }
}

export async function deleteWorkspaceFile(workspace: string, requestedPath: string): Promise<void> {
  try {
    const target = await resolveWriteTarget(workspace, requestedPath);
    await unlink(target);
  } catch {
    throw new Error('无法删除文件：目标必须位于工作区内且可访问。');
  }
}
