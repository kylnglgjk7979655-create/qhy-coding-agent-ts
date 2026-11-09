import { open, readFile, mkdir, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentError } from '../../utils/errors.js';
import { sessionStorageRoot } from './conversations.js';

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;

/** A per-session exclusive file held for the lifetime of the CLI process. */
export async function acquireSessionLock(home: string, sessionId: string): Promise<() => Promise<void>> {
  if (!idPattern.test(sessionId)) throw new AgentError('CONFIG_ERROR', '会话 ID 无效。');
  const directory = join(sessionStorageRoot(home), 'sessions', sessionId);
  const path = join(directory, 'process.lock');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const owner = `${process.pid} ${await processStartToken()} ${token}\n`;
  const temporaryPath = join(directory, `.process-lock-${token}.tmp`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(owner, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try { await link(temporaryPath, path); }
      finally { await unlink(temporaryPath).catch(() => undefined); }
      return async () => {
        try {
          const current = await readFile(path, 'utf8');
          if (current === owner) await unlink(path);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (!isAlreadyExists(error)) throw new AgentError('PROVIDER_ERROR', '无法占用会话记录。');
      if (attempt === 0 && await removeStaleLock(path)) continue;
      throw new AgentError('CONFIG_ERROR', `会话正在被其他进程使用：${sessionId}。`);
    }
  }
  throw new AgentError('CONFIG_ERROR', `会话正在被其他进程使用：${sessionId}。`);
}

async function removeStaleLock(path: string): Promise<boolean> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { return isMissing(error); }
  const [pidText, startedAt] = contents.trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (error) {
    if (isMissingProcess(error)) {
      return unlinkIfUnchanged(path, contents);
    }
    return false;
  }
  const actualStart = await processStartToken(pid);
  if (startedAt && actualStart && startedAt !== actualStart) {
    return unlinkIfUnchanged(path, contents);
  }
  return false;
}

async function unlinkIfUnchanged(path: string, expected: string): Promise<boolean> {
  try {
    if (await readFile(path, 'utf8') !== expected) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

async function processStartToken(pid = process.pid): Promise<string> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesized command start with field 3; starttime is field 22.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch { return ''; }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
