import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSession, sessionEventsPath, sessionLegacyRecordPath, sessionSnapshotPath, type SessionRecord } from '../../src/services/session/conversations.js';

/** 测试读取当前会话状态；关闭旧格式转换，避免只读断言产生额外写入。 */
export async function readStoredSession(userDir: string, conversationId?: string): Promise<SessionRecord> {
  const sessions = join(userDir, '.qhy-coding-agents', 'sessions');
  const id = conversationId ?? (await readdir(sessions))[0];
  if (!id) throw new Error('会话尚未创建');
  return loadSession(userDir, id, { convertLegacy: false });
}

/** 模拟升级前的全量 record.json 会话：清除 JSONL 与快照，只保留旧文件。 */
export async function writeLegacySession(userDir: string, record: SessionRecord): Promise<void> {
  const id = record.id;
  await mkdir(join(userDir, '.qhy-coding-agents', 'sessions', id), { recursive: true });
  await rm(sessionEventsPath(userDir, id), { force: true });
  await rm(sessionSnapshotPath(userDir, id), { force: true });
  await writeFile(sessionLegacyRecordPath(userDir, id), JSON.stringify(record));
}