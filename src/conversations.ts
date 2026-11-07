import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import type { ModelConfig } from './config.js';
import { AgentError } from './errors.js';

const conversationIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export function newConversationId(): string {
  return randomUUID();
}

export interface SessionRecord {
  version: 1;
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  config: ModelConfig;
  transcript: ModelMessage[];
  effectiveHistory: ModelMessage[];
  rounds: Array<{ id: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string }>;
  summaries: Array<{ text: string; coversThrough: number }>;
  checkpoints: Array<{ id: string; messageId: string; createdAt: string }>;
  backups: Array<{ path: string; content?: string; existed: boolean }>;
}

export function sessionStorageRoot(home = homedir()): string {
  return join(home, '.qhy-coding-agents');
}

export async function createSession(home: string, options: {
  id: string;
  workspace: string;
  config: ModelConfig;
}): Promise<SessionRecord> {
  try {
    await loadSession(home, options.id);
    throw new AgentError('CONFIG_ERROR', `会话已存在：${options.id}。`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('会话记录不存在：')) throw error;
  }
  const now = new Date().toISOString();
  const record: SessionRecord = {
    version: 1,
    id: options.id,
    workspace: resolve(options.workspace),
    createdAt: now,
    updatedAt: now,
    config: { ...options.config, workspace: resolve(options.workspace) },
    transcript: [],
    effectiveHistory: [],
    rounds: [],
    summaries: [],
    checkpoints: [],
    backups: [],
  };
  await writeSessionRecord(home, record, true);
  return record;
}

export async function loadSession(home: string, conversationId: string): Promise<SessionRecord> {
  const path = sessionRecordPath(home, conversationId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new AgentError('CONFIG_ERROR', `会话记录不存在：${conversationId}。`);
    throw new AgentError('PROVIDER_ERROR', '无法读取会话记录。');
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isSessionRecord(value) || value.id !== conversationId) throw new Error('Invalid session');
    return value;
  } catch {
    throw new AgentError('PROVIDER_ERROR', '会话记录格式无效或已损坏，未覆盖原记录。');
  }
}

export async function loadOrCreateSession(home: string, options: {
  id: string;
  workspace: string;
  config: ModelConfig;
}): Promise<SessionRecord> {
  try {
    return await loadSession(home, options.id);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('会话记录不存在：')) throw error;
    return createSession(home, options);
  }
}

export async function saveSession(home: string, record: SessionRecord): Promise<void> {
  if (!isSessionRecord(record)) throw new AgentError('CONFIG_ERROR', '会话记录结构无效，未保存。');
  const previous = await loadSession(home, record.id);
  if (previous.workspace !== record.workspace) throw new AgentError('CONFIG_ERROR', '会话工作区不可变更。');
  await writeSessionRecord(home, { ...record, updatedAt: new Date().toISOString() });
}

export async function saveSuccessfulRound(home: string, conversationId: string, prompt: string, response: ModelMessage[], effectiveHistory: ModelMessage[], startedAt: string): Promise<void> {
  const session = await loadSession(home, conversationId);
  const finishedAt = new Date().toISOString();
  const roundId = randomUUID();
  await saveSession(home, {
    ...session,
    transcript: [...session.transcript, { role: 'user', content: prompt }, ...response],
    effectiveHistory,
    rounds: [...session.rounds, { id: roundId, status: 'succeeded', startedAt, finishedAt }],
  });
}

export async function loadLegacyConversation(directory: string, conversationId: string): Promise<ModelMessage[] | undefined> {
  const path = join(directory, `${conversationId}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new AgentError('PROVIDER_ERROR', '无法读取旧版会话历史。');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isModelMessage)) throw new Error('Invalid history');
    return parsed;
  } catch {
    throw new AgentError('PROVIDER_ERROR', '旧版会话历史格式无效，未发送模型请求。');
  }
}

export async function saveLegacyConversation(directory: string, conversationId: string, messages: ModelMessage[]): Promise<void> {
  const path = join(directory, `${conversationId}.json`);
  let temporaryPath: string | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    temporaryPath = join(directory, `.${conversationId}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(messages), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } catch {
    throw new AgentError('PROVIDER_ERROR', '无法保存兼容会话历史。');
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function sessionRecordPath(home: string, conversationId: string): string {
  if (!conversationIdPattern.test(conversationId)) {
    throw new AgentError('CONFIG_ERROR', 'conversationId 仅允许 1–128 位字母、数字、下划线或连字符。');
  }
  return join(sessionStorageRoot(home), 'sessions', conversationId, 'record.json');
}

async function writeSessionRecord(home: string, record: SessionRecord, createOnly = false): Promise<void> {
  const path = sessionRecordPath(home, record.id);
  const directory = join(sessionStorageRoot(home), 'sessions', record.id);
  let temporaryPath: string | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(sessionStorageRoot(home), 0o700);
    await chmod(join(sessionStorageRoot(home), 'sessions'), 0o700);
    await chmod(directory, 0o700);
    if (createOnly) {
      try {
        await readFile(path);
        throw new AgentError('CONFIG_ERROR', `会话已存在：${record.id}。`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('PROVIDER_ERROR', '无法安全保存会话记录。');
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<SessionRecord>;
  const fields = ['version', 'id', 'workspace', 'createdAt', 'updatedAt', 'config', 'transcript', 'effectiveHistory', 'rounds', 'summaries', 'checkpoints', 'backups'];
  return Object.keys(value).every((field) => fields.includes(field))
    && session.version === 1
    && typeof session.id === 'string'
    && typeof session.workspace === 'string'
    && typeof session.createdAt === 'string'
    && typeof session.updatedAt === 'string'
    && isModelConfig(session.config)
    && Array.isArray(session.transcript) && session.transcript.every(isModelMessage)
    && Array.isArray(session.effectiveHistory) && session.effectiveHistory.every(isModelMessage)
    && Array.isArray(session.rounds) && session.rounds.every(isRoundRecord)
    && Array.isArray(session.summaries) && session.summaries.every(isSummaryRecord)
    && Array.isArray(session.checkpoints) && session.checkpoints.every(isCheckpointRecord)
    && Array.isArray(session.backups) && session.backups.every(isBackupRecord);
}

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<ModelConfig>;
  const fields = ['provider', 'model', 'apiKeyEnv', 'baseURL', 'workspace', 'timeoutMs', 'maxSteps', 'context', 'mcp', 'bash', 'approval'];
  return Object.keys(value).every((field) => fields.includes(field))
    && config.provider === 'openai'
    && typeof config.model === 'string'
    && typeof config.apiKeyEnv === 'string'
    && typeof config.workspace === 'string'
    && typeof config.timeoutMs === 'number'
    && typeof config.maxSteps === 'number'
    && typeof config.approval === 'object' && config.approval !== null;
}

function isRoundRecord(value: unknown): value is SessionRecord['rounds'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const round = value as SessionRecord['rounds'][number];
  return typeof round.id === 'string'
    && ['running', 'succeeded', 'failed', 'cancelled'].includes(round.status)
    && typeof round.startedAt === 'string'
    && (round.finishedAt === undefined || typeof round.finishedAt === 'string');
}

function isSummaryRecord(value: unknown): value is SessionRecord['summaries'][number] {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord['summaries'][number]).text === 'string'
    && typeof (value as SessionRecord['summaries'][number]).coversThrough === 'number';
}

function isCheckpointRecord(value: unknown): value is SessionRecord['checkpoints'][number] {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord['checkpoints'][number]).id === 'string'
    && typeof (value as SessionRecord['checkpoints'][number]).messageId === 'string'
    && typeof (value as SessionRecord['checkpoints'][number]).createdAt === 'string';
}

function isBackupRecord(value: unknown): value is SessionRecord['backups'][number] {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord['backups'][number]).path === 'string'
    && typeof (value as SessionRecord['backups'][number]).existed === 'boolean'
    && ((value as SessionRecord['backups'][number]).content === undefined || typeof (value as SessionRecord['backups'][number]).content === 'string');
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== 'object' || value === null || !('role' in value) || !('content' in value)) return false;
  return value.role === 'system'
    || value.role === 'developer'
    || value.role === 'user'
    || value.role === 'assistant'
    || value.role === 'tool';
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
