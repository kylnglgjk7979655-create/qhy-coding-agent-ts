import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface WorkspaceFileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

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

export async function readWorkspaceFile(workspace: string, requestedPath: string): Promise<string> {
  try {
    return await readFile(await resolveReadTarget(workspace, requestedPath), 'utf8');
  } catch {
    throw new Error('无法访问文件：目标必须存在且位于工作区内。');
  }
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
