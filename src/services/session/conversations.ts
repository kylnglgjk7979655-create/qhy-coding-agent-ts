import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import type { ModelConfig } from '../settings/config.js';
import { AgentError } from '../../utils/errors.js';
import { snapshotWorkspaceFile } from '../../tools/workspace-files.js';

const conversationIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export function newConversationId(): string {
  return randomUUID();
}

export interface SessionRecord {
  version: 1;
  id: string;
  title?: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  config: ModelConfig;
  transcript: ModelMessage[];
  effectiveHistory: ModelMessage[];
  rounds: Array<{
    id: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    startedAt: string;
    finishedAt?: string;
    config?: ModelConfig;
    transcriptStart?: number;
    messages?: ModelMessage[];
    partialText?: string;
    recovered?: boolean;
    /** 本轮已保存的压缩检查点覆盖到的 transcript 排他结束位置。 */
    compactedThrough?: number;
    /** 本轮开始时会话已有的摘要数量，成功时据此替换而不是重复追加本轮摘要。 */
    summaryStart?: number;
    error?: { code: string; message: string };
  }>;
  summaries: Array<{ text: string; coversThrough: number }>;
  checkpoints: Array<{ id: string; messageId: string; createdAt: string; files?: Array<{ path: string; backupId: string }> }>;
  backups: Array<{ id?: string; path: string; content?: string; existed: boolean }>;
}

export function sessionStorageRoot(home = homedir()): string {
  return join(home, '.qhy-coding-agents');
}

export function sessionTaskOutputDirectory(home: string, conversationId: string): string {
  if (!conversationIdPattern.test(conversationId)) {
    throw new AgentError('CONFIG_ERROR', 'conversationId 仅允许 1–128 位字母、数字、下划线或连字符。');
  }
  return join(sessionStorageRoot(home), 'sessions', conversationId, 'tasks');
}

export async function createSession(home: string, options: {
  id: string;
  workspace: string;
  config: ModelConfig;
  transcript?: ModelMessage[];
  effectiveHistory?: ModelMessage[];
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
    title: deriveSessionTitle(options.transcript ?? []),
    workspace: resolve(options.workspace),
    createdAt: now,
    updatedAt: now,
    config: { ...options.config, workspace: resolve(options.workspace) },
    transcript: options.transcript ?? [],
    effectiveHistory: options.effectiveHistory ?? [],
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
    return { ...value, title: value.title?.trim() ? value.title : deriveSessionTitle(value.transcript) };
  } catch {
    throw new AgentError('PROVIDER_ERROR', '会话记录格式无效或已损坏，未覆盖原记录。');
  }
}

export function reconstructSessionHistory(session: SessionRecord): { history: ModelMessage[]; recoveredRoundIds: string[] } {
  const pendingRounds = session.rounds
    .filter((round) => !round.recovered
      && round.transcriptStart !== undefined
      && (round.status === 'running'
        || (round.status === 'cancelled' && round.error?.code === 'CANCELLED')))
    .sort((left, right) => left.transcriptStart! - right.transcriptStart!);
  const history = [...session.effectiveHistory];
  for (const [index, round] of pendingRounds.entries()) {
    const start = round.transcriptStart!;
    const nextStart = pendingRounds[index + 1]?.transcriptStart;
    // 压缩检查点已经把该轮此前的 transcript 内容并入 effectiveHistory，只能续接其后未覆盖的消息。
    const observed = session.transcript.slice(Math.max(start, round.compactedThrough ?? 0), nextStart);
    history.push(...recoverObservedRound(observed));
  }
  return { history, recoveredRoundIds: pendingRounds.map(({ id }) => id) };
}

function recoverObservedRound(messages: ModelMessage[]): ModelMessage[] {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    const parts = message.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const value = part as Record<string, unknown>;
      if (value.type === 'tool-call' && typeof value.toolCallId === 'string') calls.add(value.toolCallId);
      if (value.type === 'tool-result' && typeof value.toolCallId === 'string') results.add(value.toolCallId);
    }
  }
  const paired = new Set([...calls].filter((id) => results.has(id)));
  const recovered: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content.filter((part) => {
        if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'tool-call') return true;
        const callId = (part as { toolCallId?: unknown }).toolCallId;
        return typeof callId === 'string' && paired.has(callId);
      });
      if (content.length > 0) recovered.push({ ...message, content } as ModelMessage);
      continue;
    }
    if (message.role === 'tool') {
      if (!Array.isArray(message.content)) continue;
      const content = message.content.flatMap((part) => {
        if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'tool-result') return [];
        const result = part as Record<string, unknown>;
        if (typeof result.toolCallId !== 'string' || !paired.has(result.toolCallId)) return [];
        // Transcript stores the observed tool output verbatim; ModelMessage expects an output envelope.
        return [{ ...result, output: { type: 'json', value: result.output } }];
      });
      if (content.length > 0) recovered.push({ ...message, content } as ModelMessage);
      continue;
    }
    recovered.push(message);
  }
  if (paired.size > 0) {
    recovered.push({
      role: 'assistant',
      content: '恢复说明：以上仅包含已保存且调用 ID 配对的真实工具结果；进程在本轮最终答复生成前中断，未观察到该轮最终结果。',
    });
  }
  return recovered;
}

export async function listSessions(home: string, workspace?: string): Promise<SessionRecord[]> {
  const directory = join(sessionStorageRoot(home), 'sessions');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new AgentError('PROVIDER_ERROR', '无法列出会话记录。');
  }
  const sessions = await Promise.all(entries.map((id) => loadSession(home, id)));
  return sessions
    .filter((session) => workspace === undefined || session.workspace === resolve(workspace))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
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

export async function appendSessionEvent(home: string, conversationId: string, messages: ModelMessage[]): Promise<void> {
  const session = await loadSession(home, conversationId);
  await saveSession(home, {
    ...session,
    transcript: [...session.transcript, ...messages],
    effectiveHistory: [...session.effectiveHistory, ...messages],
  });
}

export async function startSessionRound(
  home: string,
  conversationId: string,
  prompt: string,
  config: ModelConfig,
  onCheckpointError?: (path: string) => void,
): Promise<string> {
  const session = await loadSession(home, conversationId);
  const roundId = randomUUID();
  const transcriptStart = session.transcript.length;
  const checkpointFiles: Array<{ path: string; backupId: string }> = [];
  const backups = [...session.backups];
  for (const path of new Set(backups.map((backup) => backup.path))) {
    try {
      const snapshot = await snapshotWorkspaceFile(session.workspace, path);
      const backupId = randomUUID();
      backups.push({ id: backupId, ...snapshot });
      checkpointFiles.push({ path, backupId });
    } catch {
      // A checkpoint is best-effort; the message and its original tool work must still proceed.
      onCheckpointError?.(path);
    }
  }
  await saveSession(home, {
    ...session,
    title: !session.title || session.title === '未命名会话' ? deriveTitleFromText(prompt) : session.title,
    transcript: [...session.transcript, { role: 'user', content: prompt }],
    rounds: [...session.rounds, { id: roundId, status: 'running', startedAt: new Date().toISOString(), config, transcriptStart, messages: [], partialText: '', summaryStart: session.summaries.length }],
    checkpoints: [...session.checkpoints, { id: randomUUID(), messageId: roundId, createdAt: new Date().toISOString(), files: checkpointFiles }],
    backups,
  });
  return roundId;
}

export async function recordFileBackup(
  home: string,
  conversationId: string,
  roundId: string,
  snapshot: { path: string; existed: boolean; content?: string },
): Promise<void> {
  const session = await loadSession(home, conversationId);
  const backupId = randomUUID();
  const checkpoints = session.checkpoints.map((checkpoint) => {
    if (checkpoint.files?.some((file) => file.path === snapshot.path)) return checkpoint;
    return { ...checkpoint, files: [...(checkpoint.files ?? []), { path: snapshot.path, backupId }] };
  });
  if (!checkpoints.some((checkpoint) => checkpoint.messageId === roundId)) {
    throw new AgentError('PROVIDER_ERROR', '当前消息检查点不可用。');
  }
  await saveSession(home, {
    ...session,
    checkpoints,
    backups: [...session.backups, { id: backupId, ...snapshot }],
  });
}

export async function appendRoundMessages(home: string, conversationId: string, roundId: string, messages: ModelMessage[]): Promise<void> {
  await updateRound(home, conversationId, roundId, (round) => ({
    ...round,
    messages: [
      ...(round.messages ?? []),
      ...(round.partialText ? [{ role: 'assistant' as const, content: round.partialText }] : []),
      ...messages,
    ],
    partialText: '',
  }));
}

export async function appendRoundText(home: string, conversationId: string, roundId: string, text: string): Promise<void> {
  await updateRound(home, conversationId, roundId, (round) => ({ ...round, partialText: `${round.partialText ?? ''}${text}` }));
}

/**
 * 摘要成功后立即保存压缩检查点：活动轮次的摘要、覆盖边界和压缩后的有效历史立即可用于续聊。
 * 覆盖边界取保存时 transcript 的实际长度，不依赖摘要或附件占用的消息数量。
 * 保存失败时抛出错误，调用方据此停止本轮，压缩前的有效历史保持可恢复。
 */
export async function saveCompactionCheckpoint(home: string, conversationId: string, roundId: string, checkpoint: {
  effectiveHistory: ModelMessage[];
  summary: { text: string };
}): Promise<SessionRecord['summaries'][number]> {
  const session = await loadSession(home, conversationId);
  const index = session.rounds.findIndex((round) => round.id === roundId);
  const current = session.rounds[index];
  if (!current || current.status !== 'running') throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，压缩检查点未保存。');
  const entry = { text: checkpoint.summary.text, coversThrough: session.transcript.length };
  const previous = session.summaries.at(-1);
  const unchanged = previous !== undefined
    && previous.text === entry.text
    && previous.coversThrough === entry.coversThrough;
  await saveSession(home, {
    ...session,
    effectiveHistory: checkpoint.effectiveHistory,
    summaries: unchanged ? session.summaries : [...session.summaries, entry],
    rounds: session.rounds.map((round, roundIndex) => roundIndex === index
      ? { ...round, compactedThrough: Math.max(round.compactedThrough ?? 0, entry.coversThrough) }
      : round),
  });
  return entry;
}

export async function finishSessionRound(home: string, conversationId: string, roundId: string, outcome: {
  status: 'succeeded' | 'failed' | 'cancelled';
  response?: ModelMessage[];
  effectiveHistory?: ModelMessage[];
  summaries?: SessionRecord['summaries'];
  recoveredRoundIds?: string[];
  error?: { code: string; message: string };
}): Promise<void> {
  await updateRound(home, conversationId, roundId, (round) => ({
    ...round,
    status: outcome.status,
    finishedAt: new Date().toISOString(),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.status === 'succeeded' ? { messages: outcome.response ?? round.messages ?? [], partialText: '' } : {}),
  }), outcome.effectiveHistory, outcome.recoveredRoundIds, outcome.summaries);
}

async function updateRound(
  home: string,
  conversationId: string,
  roundId: string,
  update: (round: SessionRecord['rounds'][number]) => SessionRecord['rounds'][number],
  effectiveHistory?: ModelMessage[],
  recoveredRoundIds: string[] = [],
  summaries: SessionRecord['summaries'] = [],
): Promise<void> {
  const session = await loadSession(home, conversationId);
  const index = session.rounds.findIndex((round) => round.id === roundId);
  const current = session.rounds[index];
  if (!current || current.status !== 'running') throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，已停止后续操作。');
  const round = update(current);
  const transcriptStart = current.transcriptStart ?? session.transcript.length - 1;
  const observed = [...(round.messages ?? []), ...(round.partialText ? [{ role: 'assistant' as const, content: round.partialText }] : [])];
  const rebuilt = [...session.transcript.slice(0, transcriptStart + 1), ...observed];
  // 压缩检查点按 transcript 实际长度记录覆盖边界；最终结果合并同批工具调用后可能更短，保留已保存记录避免边界失效。
  const transcript = current.compactedThrough !== undefined && rebuilt.length < current.compactedThrough
    ? session.transcript
    : rebuilt;
  // 本轮摘要只替换本轮之前已保存的部分；检查点已经持久化的摘要由本轮结果统一覆盖，避免重复追加。
  const summaryStart = current.summaryStart ?? session.summaries.length;
  await saveSession(home, {
    ...session,
    transcript,
    rounds: session.rounds.map((item, itemIndex) => itemIndex === index
      ? round
      : recoveredRoundIds.includes(item.id) ? { ...item, recovered: true } : item),
    ...(effectiveHistory ? { effectiveHistory } : {}),
    ...(effectiveHistory ? { summaries: [...session.summaries.slice(0, summaryStart), ...summaries] } : {}),
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

export function sessionRecordPath(home: string, conversationId: string): string {
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
  const fields = ['version', 'id', 'title', 'workspace', 'createdAt', 'updatedAt', 'config', 'transcript', 'effectiveHistory', 'rounds', 'summaries', 'checkpoints', 'backups'];
  return Object.keys(value).every((field) => fields.includes(field))
    && session.version === 1
    && typeof session.id === 'string'
    && (session.title === undefined || typeof session.title === 'string')
    && typeof session.workspace === 'string'
    && typeof session.createdAt === 'string'
    && typeof session.updatedAt === 'string'
    && isModelConfig(session.config)
    && Array.isArray(session.transcript) && session.transcript.every(isModelMessage)
    && Array.isArray(session.effectiveHistory) && session.effectiveHistory.every(isModelMessage)
    && Array.isArray(session.rounds) && session.rounds.every(isRoundRecord)
    && Array.isArray(session.summaries) && session.summaries.every(isSummaryRecord)
    && session.summaries.every((summary, index) => summary.coversThrough <= session.transcript!.length
      && (index === 0 || summary.coversThrough >= session.summaries![index - 1]!.coversThrough))
    && Array.isArray(session.checkpoints) && session.checkpoints.every(isCheckpointRecord)
    && Array.isArray(session.backups) && session.backups.every(isBackupRecord);
}

function deriveSessionTitle(transcript: ModelMessage[]): string {
  const firstUserMessage = transcript.find((message) => message.role === 'user');
  if (!firstUserMessage) return '未命名会话';
  const content = typeof firstUserMessage.content === 'string'
    ? firstUserMessage.content
    : Array.isArray(firstUserMessage.content)
      ? firstUserMessage.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(' ')
      : '';
  return deriveTitleFromText(content);
}

function deriveTitleFromText(text: string): string {
  const readable = text.replace(/\s+/gu, ' ').trim();
  if (!readable) return '未命名会话';
  const characters = Array.from(readable);
  return characters.length > 100 ? `${characters.slice(0, 100).join('')}…` : readable;
}

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<ModelConfig>;
  const fields = ['provider', 'model', 'apiKeyEnv', 'baseURL', 'workspace', 'timeoutMs', 'maxSteps', 'explore', 'context', 'mcp', 'bash', 'approval', 'permissions'];
  return Object.keys(value).every((field) => fields.includes(field))
    && config.provider === 'openai'
    && typeof config.model === 'string'
    && typeof config.apiKeyEnv === 'string'
    && typeof config.workspace === 'string'
    && typeof config.timeoutMs === 'number'
    && typeof config.maxSteps === 'number'
    && (config.explore === undefined || (typeof config.explore === 'object' && config.explore !== null
      && Object.keys(config.explore).every((field) => ['model', 'loadRootAgents'].includes(field))
      && (config.explore.model === undefined || (typeof config.explore.model === 'string' && config.explore.model.trim() !== ''))
      && (config.explore.loadRootAgents === undefined || typeof config.explore.loadRootAgents === 'boolean')))
    && typeof config.approval === 'object' && config.approval !== null;
}

function isRoundRecord(value: unknown): value is SessionRecord['rounds'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const round = value as SessionRecord['rounds'][number];
  return typeof round.id === 'string'
    && ['running', 'succeeded', 'failed', 'cancelled'].includes(round.status)
    && typeof round.startedAt === 'string'
    && (round.finishedAt === undefined || typeof round.finishedAt === 'string')
    && (round.config === undefined || isModelConfig(round.config))
    && (round.transcriptStart === undefined || typeof round.transcriptStart === 'number')
    && (round.messages === undefined || (Array.isArray(round.messages) && round.messages.every(isModelMessage)))
    && (round.partialText === undefined || typeof round.partialText === 'string')
    && (round.recovered === undefined || typeof round.recovered === 'boolean')
    && (round.compactedThrough === undefined || (Number.isSafeInteger(round.compactedThrough) && round.compactedThrough >= 0))
    && (round.summaryStart === undefined || (Number.isSafeInteger(round.summaryStart) && round.summaryStart >= 0))
    && (round.error === undefined || (typeof round.error === 'object' && round.error !== null
      && typeof round.error.code === 'string' && typeof round.error.message === 'string'));
}

function isSummaryRecord(value: unknown): value is SessionRecord['summaries'][number] {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord['summaries'][number]).text === 'string'
    && (value as SessionRecord['summaries'][number]).text.trim().length > 0
    && Number.isSafeInteger((value as SessionRecord['summaries'][number]).coversThrough)
    && (value as SessionRecord['summaries'][number]).coversThrough >= 0;
}

function isCheckpointRecord(value: unknown): value is SessionRecord['checkpoints'][number] {
  return typeof value === 'object' && value !== null
    && typeof (value as SessionRecord['checkpoints'][number]).id === 'string'
    && typeof (value as SessionRecord['checkpoints'][number]).messageId === 'string'
    && typeof (value as SessionRecord['checkpoints'][number]).createdAt === 'string'
    && ((value as SessionRecord['checkpoints'][number]).files === undefined
      || (Array.isArray((value as SessionRecord['checkpoints'][number]).files)
        && (value as SessionRecord['checkpoints'][number]).files!.every((file) => typeof file.path === 'string' && typeof file.backupId === 'string')));
}

function isBackupRecord(value: unknown): value is SessionRecord['backups'][number] {
  return typeof value === 'object' && value !== null
    && ((value as SessionRecord['backups'][number]).id === undefined || typeof (value as SessionRecord['backups'][number]).id === 'string')
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
