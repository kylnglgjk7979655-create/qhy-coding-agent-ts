import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import type { ModelConfig } from '../settings/config.js';
import { withoutHookConfig } from '../settings/config.js';
import { AgentError } from '../../utils/errors.js';
import { appendRecentSkillLoads } from '../skills/skill-injection.js';
import { snapshotWorkspaceFile } from '../../tools/workspace-files.js';

const conversationIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const eventLogVersion = 1;
const snapshotVersion = 1;
/** 每追加 N 条事件写一次完整快照；快照只加速恢复，不截断或替代事件日志。 */
const snapshotEventInterval = 64;

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
  /** 最近实际加载的 Skill 规范名称，按加载顺序；同一 Skill 只保留最近一次位置。 */
  skillLoads?: string[];
  /** 最近成功注入的完整正文；与规范名加载顺序一起保存，旧记录可缺省。 */
  skillBodies?: Record<string, string>;
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
  summaries: Array<{ text: string; coversThrough: number; /** 该摘要恢复的 Skill 正文条数，不计入 coversThrough。 */ restoredMessages?: number }>;
  checkpoints: Array<{ id: string; messageId: string; createdAt: string; files?: Array<{ path: string; backupId: string }> }>;
  backups: Array<{ id?: string; path: string; content?: string; existed: boolean }>;
  /** 最近成功读取的文件标识（规范绝对路径），按最近优先去重保存，供压缩恢复使用。 */
  recentFiles: string[];
}

export interface SessionLoadWarning {
  code: 'incomplete-tail' | 'snapshot-ignored';
  message: string;
}

export interface SessionLoadOptions {
  /** 恢复时发现未完成尾行或无效快照时回调；同一进程内可据此提示用户。 */
  onWarning?: (warning: SessionLoadWarning) => void;
  /** 旧 record.json 是否在首次读取时转换为 JSONL；列目录等只读场景可关闭。 */
  convertLegacy?: boolean;
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

/** 新会话的追加式事件日志；旧会话首次打开后也迁移到该文件。 */
export function sessionEventsPath(home: string, conversationId: string): string {
  assertConversationId(conversationId);
  return join(sessionStorageRoot(home), 'sessions', conversationId, 'events.jsonl');
}

export function sessionSnapshotPath(home: string, conversationId: string): string {
  assertConversationId(conversationId);
  return join(sessionStorageRoot(home), 'sessions', conversationId, 'snapshot.json');
}

/** 旧版全量 JSON 记录；转换后保留原文件作为兼容备份，但不再读取或改写。 */
export function sessionLegacyRecordPath(home: string, conversationId: string): string {
  assertConversationId(conversationId);
  return join(sessionStorageRoot(home), 'sessions', conversationId, 'record.json');
}

/** 兼容旧调用名：摘要包装等场景把该路径作为完整原始记录位置展示。 */
export function sessionRecordPath(home: string, conversationId: string): string {
  return sessionEventsPath(home, conversationId);
}

export async function createSession(home: string, options: {
  id: string;
  workspace: string;
  config: ModelConfig;
  transcript?: ModelMessage[];
  effectiveHistory?: ModelMessage[];
}): Promise<SessionRecord> {
  try {
    await loadSession(home, options.id, { convertLegacy: false });
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
    skillLoads: [],
    rounds: [],
    summaries: [],
    checkpoints: [],
    backups: [],
    recentFiles: [],
  };
  const path = sessionEventsPath(home, options.id);
  await prepareSessionDirectory(home, options.id);
  try {
    // Hook 配置不随会话持久化：首个 create 事件同样剔除。
    const persisted = pruneSessionHookConfig(record);
    await writeFile(path, serializeEvent(1, now, { type: 'create', record: persisted }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (isExist(error)) throw new AgentError('CONFIG_ERROR', `会话已存在：${options.id}。`);
    throw new AgentError('PROVIDER_ERROR', '无法安全保存会话记录。');
  }
  return record;
}

export async function loadSession(home: string, conversationId: string, options: SessionLoadOptions = {}): Promise<SessionRecord> {
  const state = await readSessionState(home, conversationId, options);
  // 旧快照/事件里的 hooks 直接忽略；恢复对话时按当前 settings 重新加载。
  const record = pruneSessionHookConfig(state.record);
  if (state.legacy && options.convertLegacy !== false) {
    // 首次打开旧会话时按需转换；转换失败不阻塞只读续聊，后续写入会重试。
    await writeLegacyConversion(home, conversationId, record, state.eventsEmpty).catch(() => undefined);
  }
  return record;
}

export function reconstructSessionHistory(session: SessionRecord): { history: ModelMessage[]; recoveredRoundIds: string[] } {
  const pendingRounds = session.rounds
    .filter((round) => !round.recovered
      && round.transcriptStart !== undefined
      && (round.status === 'running'
        || (round.status === 'cancelled' && round.error?.code === 'CANCELLED')))
    .sort((left, right) => left.transcriptStart! - right.transcriptStart!);
  const history = [...session.effectiveHistory];
  // 覆盖边界是 transcript 的绝对位置：最近一次检查点已经覆盖其之前的全部内容，包括更早的中断轮次。
  // 若只看本轮的 compactedThrough，跨进程续聊会在摘要之上重复回放已被摘要覆盖的消息。
  const compactedThrough = session.rounds.reduce((max, round) => Math.max(max, round.compactedThrough ?? 0), 0);
  for (const [index, round] of pendingRounds.entries()) {
    const start = round.transcriptStart!;
    const nextStart = pendingRounds[index + 1]?.transcriptStart;
    // 压缩检查点已经把此前 transcript 内容并入 effectiveHistory，只能续接其后未覆盖的消息。
    const observed = session.transcript.slice(Math.max(start, compactedThrough), nextStart);
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
  // 列出会话不批量迁移旧记录：旧 JSON 会话保持只读，首次续聊时才转换。
  const sessions = await Promise.all(entries.map((id) => loadSession(home, id, { convertLegacy: false })));
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
  const session = pruneSessionHookConfig(record);
  if (!isSessionRecord(session)) throw new AgentError('CONFIG_ERROR', '会话记录结构无效，未保存。');
  const previous = await loadSession(home, session.id);
  if (previous.workspace !== session.workspace) throw new AgentError('CONFIG_ERROR', '会话工作区不可变更。');
  // 显式 saveSession 保留全量替换语义，作为兼容入口；常规轮次更新走增量事件。
  await commitSession(home, session.id, () => ({
    type: 'record',
    record: { ...session, updatedAt: new Date().toISOString() },
  }), { snapshot: true });
}

export async function appendSessionEvent(home: string, conversationId: string, messages: ModelMessage[]): Promise<void> {
  await commitSession(home, conversationId, () => ({ type: 'messages-append', messages }));
}

export async function startSessionRound(
  home: string,
  conversationId: string,
  prompt: string,
  config: ModelConfig,
  onCheckpointError?: (path: string) => void,
): Promise<string> {
  let roundId = '';
  await commitSession(home, conversationId, async (session) => {
    roundId = randomUUID();
    const transcriptStart = session.transcript.length;
    const checkpointFiles: Array<{ path: string; backupId: string }> = [];
    const newBackups: SessionRecord['backups'] = [];
    for (const path of new Set(session.backups.map((backup) => backup.path))) {
      try {
        const snapshot = await snapshotWorkspaceFile(session.workspace, path);
        const backupId = randomUUID();
        newBackups.push({ id: backupId, ...snapshot });
        checkpointFiles.push({ path, backupId });
      } catch {
        // A checkpoint is best-effort; the message and its original tool work must still proceed.
        onCheckpointError?.(path);
      }
    }
    const now = new Date().toISOString();
    return {
      type: 'round-start',
      ...(!session.title || session.title === '未命名会话' ? { title: deriveTitleFromText(prompt) } : {}),
      userMessage: { role: 'user', content: prompt },
      round: { id: roundId, status: 'running', startedAt: now, config, transcriptStart, messages: [], partialText: '', summaryStart: session.summaries.length },
      checkpoint: { id: randomUUID(), messageId: roundId, createdAt: now, files: checkpointFiles },
      backups: newBackups,
    };
  });
  return roundId;
}

export async function recordFileBackup(
  home: string,
  conversationId: string,
  roundId: string,
  snapshot: { path: string; existed: boolean; content?: string },
): Promise<void> {
  await commitSession(home, conversationId, (session) => {
    const backupId = randomUUID();
    const checkpoints = session.checkpoints.map((checkpoint) => {
      if (checkpoint.files?.some((file) => file.path === snapshot.path)) return checkpoint;
      return { ...checkpoint, files: [...(checkpoint.files ?? []), { path: snapshot.path, backupId }] };
    });
    if (!checkpoints.some((checkpoint) => checkpoint.messageId === roundId)) {
      throw new AgentError('PROVIDER_ERROR', '当前消息检查点不可用。');
    }
    return { type: 'file-backup', checkpoints, backup: { id: backupId, ...snapshot } };
  });
}

export async function appendRoundMessages(home: string, conversationId: string, roundId: string, messages: ModelMessage[]): Promise<void> {
  await commitSession(home, conversationId, (session) => {
    requireRunningRound(session, roundId);
    return { type: 'round-messages', roundId, messages };
  });
}

export async function appendRoundText(home: string, conversationId: string, roundId: string, text: string): Promise<void> {
  await commitSession(home, conversationId, (session) => {
    requireRunningRound(session, roundId);
    return { type: 'round-text', roundId, text };
  });
}

function requireRunningRound(session: SessionRecord, roundId: string): SessionRecord['rounds'][number] {
  const round = session.rounds.find((item) => item.id === roundId);
  if (!round || round.status !== 'running') throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，已停止后续操作。');
  return round;
}

/**
 * 摘要成功后立即保存压缩检查点：活动轮次的摘要、覆盖边界和压缩后的有效历史立即可用于续聊。
 * 覆盖边界取保存时 transcript 的实际长度，不依赖摘要或附件占用的消息数量。
 * 保存失败时抛出错误，调用方据此停止本轮，压缩前的有效历史保持可恢复。
 */
export async function saveCompactionCheckpoint(home: string, conversationId: string, roundId: string, checkpoint: {
  effectiveHistory: ModelMessage[];
  summary: { text: string; restoredMessages?: number };
  recentFiles?: string[];
}): Promise<SessionRecord['summaries'][number]> {
  let entry: SessionRecord['summaries'][number] | undefined;
  await commitSession(home, conversationId, (session) => {
    const index = session.rounds.findIndex((round) => round.id === roundId);
    const current = session.rounds[index];
    if (!current || current.status !== 'running') throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，压缩检查点未保存。');
    const nextEntry = {
      text: checkpoint.summary.text,
      coversThrough: session.transcript.length,
      ...(checkpoint.summary.restoredMessages ? { restoredMessages: checkpoint.summary.restoredMessages } : {}),
    };
    entry = nextEntry;
    return {
      type: 'compaction',
      entry: nextEntry,
      effectiveHistory: checkpoint.effectiveHistory,
      ...(checkpoint.recentFiles ? { recentFiles: checkpoint.recentFiles } : {}),
      rounds: session.rounds.map((round, roundIndex) => roundIndex === index
        ? { ...round, compactedThrough: Math.max(round.compactedThrough ?? 0, nextEntry.coversThrough) }
        : round),
    };
  }, { snapshot: true });
  if (!entry) throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，压缩检查点未保存。');
  return entry;
}

/**
 * 空闲时手动压缩：保存摘要、覆盖边界和压缩后的有效历史。
 * 覆盖边界取当前 transcript 长度，并把已有轮次标记为已覆盖，避免续聊时重现已进入摘要的原文。
 * 保存失败时抛出错误，压缩前的有效历史保持不变。
 */
export async function saveManualCompaction(home: string, conversationId: string, checkpoint: {
  effectiveHistory: ModelMessage[];
  summary: { text: string; restoredMessages?: number };
  recentFiles?: string[];
}): Promise<void> {
  await commitSession(home, conversationId, (session) => {
    const entry = {
      text: checkpoint.summary.text,
      coversThrough: session.transcript.length,
      ...(checkpoint.summary.restoredMessages ? { restoredMessages: checkpoint.summary.restoredMessages } : {}),
    };
    return {
      type: 'compaction',
      entry,
      effectiveHistory: checkpoint.effectiveHistory,
      ...(checkpoint.recentFiles ? { recentFiles: checkpoint.recentFiles } : {}),
      rounds: session.rounds.map((round) =>
        (round.compactedThrough ?? 0) >= entry.coversThrough
          ? round
          : { ...round, compactedThrough: entry.coversThrough }),
    };
  }, { snapshot: true });
}

export async function finishSessionRound(home: string, conversationId: string, roundId: string, outcome: {
  status: 'succeeded' | 'failed' | 'cancelled';
  response?: ModelMessage[];
  effectiveHistory?: ModelMessage[];
  summaries?: SessionRecord['summaries'];
  recoveredRoundIds?: string[];
  recentFiles?: string[];
  /** 本轮新注入的 Skill 规范名称；已有顺序保留并追加到末尾。 */
  skillLoads?: string[];
  skillBodies?: Record<string, string>;
  error?: { code: string; message: string };
}): Promise<void> {
  await updateRound(home, conversationId, roundId, (round) => ({
    ...round,
    status: outcome.status,
    finishedAt: new Date().toISOString(),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.status === 'succeeded' ? { messages: outcome.response ?? round.messages ?? [], partialText: '' } : {}),
  }), outcome.effectiveHistory, outcome.recoveredRoundIds, outcome.summaries, outcome.recentFiles,
    outcome.skillLoads, outcome.status === 'succeeded' ? outcome.skillBodies : undefined);
}

async function updateRound(
  home: string,
  conversationId: string,
  roundId: string,
  update: (round: SessionRecord['rounds'][number]) => SessionRecord['rounds'][number],
  effectiveHistory?: ModelMessage[],
  recoveredRoundIds: string[] = [],
  summaries: SessionRecord['summaries'] = [],
  recentFiles?: string[],
  skillLoads: readonly string[] = [],
  skillBodies?: Readonly<Record<string, string>>,
): Promise<void> {
  await commitSession(home, conversationId, (session) => {
    const index = session.rounds.findIndex((round) => round.id === roundId);
    const current = session.rounds[index];
    if (!current || current.status !== 'running') throw new AgentError('PROVIDER_ERROR', '当前轮次记录不可用，已停止后续操作。');
    const round = update(current);
    const transcriptStart = current.transcriptStart ?? session.transcript.length - 1;
    const observed = [...(round.messages ?? []), ...(round.partialText ? [{ role: 'assistant' as const, content: round.partialText }] : [])];
    const rebuilt = [...session.transcript.slice(0, transcriptStart + 1), ...observed];
    // 压缩检查点按 transcript 实际长度记录覆盖边界；最终结果合并同批工具调用后可能更短，保留已保存记录避免边界失效。
    const keepTranscript = current.compactedThrough !== undefined && rebuilt.length < current.compactedThrough;
    // 本轮摘要只替换本轮之前已保存的部分；检查点已经持久化的摘要由本轮结果统一覆盖，避免重复追加。
    const summaryStart = current.summaryStart ?? session.summaries.length;
    // 旧记录没有该字段时保持缺省；只有新加载发生后才写入最近顺序。
    const recentSkillLoads = skillLoads.length === 0
      ? session.skillLoads
      : appendRecentSkillLoads(session.skillLoads ?? [], skillLoads);
    return {
      type: 'round-finish',
      roundId,
      round,
      transcript: keepTranscript
        ? { mode: 'keep' }
        : { mode: 'replace', start: transcriptStart, messages: observed },
      ...(effectiveHistory ? { effectiveHistory: historyMutation(session.effectiveHistory, effectiveHistory) } : {}),
      ...(effectiveHistory ? { summaries: { start: summaryStart, entries: summaries } } : {}),
      ...(recentFiles ? { recentFiles } : {}),
      ...(recentSkillLoads === undefined ? {} : { skillLoads: recentSkillLoads }),
      ...(skillBodies === undefined || Object.keys(skillBodies).length === 0
        ? {} : { skillBodies }),
      recoveredRoundIds,
    };
  });
}

/** 有效历史通常只在末尾追加；只有压缩等替换场景才写全量事件。 */
function historyMutation(previous: ModelMessage[], next: ModelMessage[]): HistoryMutation {
  if (next.length >= previous.length && previous.every((message, index) => sameValue(message, next[index]))) {
    return { mode: 'append', messages: next.slice(previous.length) };
  }
  return { mode: 'replace', messages: next };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

type HistoryMutation =
  | { mode: 'append'; messages: ModelMessage[] }
  | { mode: 'replace'; messages: ModelMessage[] };

type SessionMutation =
  | { type: 'create'; record: SessionRecord }
  | { type: 'record'; record: SessionRecord }
  | { type: 'messages-append'; messages: ModelMessage[] }
  | {
    type: 'round-start';
    title?: string;
    userMessage: ModelMessage;
    round: SessionRecord['rounds'][number];
    checkpoint: SessionRecord['checkpoints'][number];
    backups: SessionRecord['backups'];
  }
  | { type: 'round-text'; roundId: string; text: string }
  | { type: 'round-messages'; roundId: string; messages: ModelMessage[] }
  | {
    type: 'round-finish';
    roundId: string;
    round: SessionRecord['rounds'][number];
    transcript: { mode: 'keep' } | { mode: 'replace'; start: number; messages: ModelMessage[] };
    effectiveHistory?: HistoryMutation;
    summaries?: { start: number; entries: SessionRecord['summaries'] };
    recentFiles?: string[];
    skillLoads?: string[];
    skillBodies?: Record<string, string>;
    recoveredRoundIds: string[];
  }
  | {
    type: 'file-backup';
    checkpoints: SessionRecord['checkpoints'];
    backup: SessionRecord['backups'][number];
  }
  | {
    type: 'compaction';
    entry: SessionRecord['summaries'][number];
    effectiveHistory: ModelMessage[];
    rounds: SessionRecord['rounds'];
    recentFiles?: string[];
  };

interface StoredSessionEvent {
  v: 1;
  seq: number;
  at: string;
  type: SessionMutation['type'];
  data: unknown;
}

interface SessionSnapshot {
  v: 1;
  id: string;
  eventSeq: number;
  byteOffset: number;
  record: SessionRecord;
}

interface SessionState {
  record: SessionRecord;
  seq: number;
  snapshotSeq: number;
  eventsByteOffset: number;
  legacy: boolean;
  eventsEmpty: boolean;
}

/** 追加事件并（按周期）刷新快照；所有写操作在会话锁内单写者调用。 */
async function commitSession(
  home: string,
  conversationId: string,
  build: (record: SessionRecord) => SessionMutation | Promise<SessionMutation>,
  options: { snapshot?: boolean } = {},
): Promise<SessionRecord> {
  const state = await readSessionState(home, conversationId);
  // Hook 配置不随会话持久化：写入前统一剔除会话级与轮次级 config 中的 Hook 字段。
  const mutation = pruneSessionMutation(await build(state.record));
  const at = new Date().toISOString();
  const next = pruneSessionHookConfig(applySessionMutation(state.record, mutation, at));
  if (!isSessionRecord(next)) throw new AgentError('CONFIG_ERROR', '会话记录结构无效，未保存。');
  const eventsPath = sessionEventsPath(home, conversationId);
  let seq = state.seq;
  let byteOffset = state.eventsByteOffset;
  try {
    await prepareSessionDirectory(home, conversationId);
    if (state.legacy) {
      const line = serializeEvent(1, state.record.updatedAt, { type: 'create', record: state.record });
      await writeEventLogLine(eventsPath, line, state.eventsEmpty ? 'w' : 'wx');
      seq = 1;
      byteOffset = Buffer.byteLength(line);
    }
    const line = serializeEvent(seq + 1, at, mutation);
    const trimmedSize = await trimIncompleteTail(eventsPath);
    await appendFile(eventsPath, line, { encoding: 'utf8', mode: 0o600 });
    seq += 1;
    byteOffset = trimmedSize + Buffer.byteLength(line);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('PROVIDER_ERROR', '无法安全保存会话记录。');
  }
  const forceSnapshot = options.snapshot === true || mutation.type === 'record' || mutation.type === 'compaction';
  await writeSnapshotIfDue(home, conversationId, next, seq, byteOffset, state.snapshotSeq, forceSnapshot);
  return next;
}

function applySessionMutation(record: SessionRecord, mutation: SessionMutation, at: string): SessionRecord {
  let next: SessionRecord;
  switch (mutation.type) {
    case 'create':
    case 'record':
      next = { ...mutation.record };
      break;
    case 'messages-append':
      next = { ...record, transcript: [...record.transcript, ...mutation.messages], effectiveHistory: [...record.effectiveHistory, ...mutation.messages] };
      break;
    case 'round-start': {
      const updated = {
        ...record,
        transcript: [...record.transcript, mutation.userMessage],
        rounds: [...record.rounds, mutation.round],
        checkpoints: [...record.checkpoints, mutation.checkpoint],
        backups: [...record.backups, ...mutation.backups],
      };
      next = mutation.title === undefined ? updated : { ...updated, title: mutation.title };
      break;
    }
    case 'round-text': {
      const index = requireRoundIndex(record, mutation.roundId);
      const rounds = record.rounds.map((round, roundIndex) => roundIndex === index
        ? { ...round, partialText: `${round.partialText ?? ''}${mutation.text}` }
        : round);
      // Transcript 持续反映已观察内容；压缩检查点按实际 transcript 长度记录覆盖边界。
      next = { ...record, rounds, transcript: rebuildRoundTranscript(record, rounds[index]!) };
      break;
    }
    case 'round-messages': {
      const index = requireRoundIndex(record, mutation.roundId);
      const rounds = record.rounds.map((round, roundIndex) => roundIndex === index
        ? {
          ...round,
          messages: [
            ...(round.messages ?? []),
            ...(round.partialText ? [{ role: 'assistant' as const, content: round.partialText }] : []),
            ...mutation.messages,
          ],
          partialText: '',
        }
        : round);
      next = { ...record, rounds, transcript: rebuildRoundTranscript(record, rounds[index]!) };
      break;
    }
    case 'round-finish': {
      const recovered = new Set(mutation.recoveredRoundIds);
      const rounds = record.rounds.map((round) => round.id === mutation.roundId
        ? mutation.round
        : recovered.has(round.id) ? { ...round, recovered: true } : round);
      const transcript = mutation.transcript.mode === 'keep'
        ? record.transcript
        : [...record.transcript.slice(0, mutation.transcript.start + 1), ...mutation.transcript.messages];
      const effectiveHistory = mutation.effectiveHistory === undefined
        ? record.effectiveHistory
        : applyHistoryMutation(record.effectiveHistory, mutation.effectiveHistory);
      const summaries = mutation.summaries === undefined
        ? record.summaries
        : [...record.summaries.slice(0, mutation.summaries.start), ...mutation.summaries.entries];
      next = {
        ...record,
        transcript,
        effectiveHistory,
        summaries,
        rounds,
        ...(mutation.recentFiles === undefined ? {} : { recentFiles: mutation.recentFiles }),
        ...(mutation.skillLoads === undefined ? {} : { skillLoads: mutation.skillLoads }),
        ...(mutation.skillBodies === undefined
          ? {} : { skillBodies: { ...record.skillBodies, ...mutation.skillBodies } }),
      };
      break;
    }
    case 'file-backup':
      next = { ...record, checkpoints: mutation.checkpoints, backups: [...record.backups, mutation.backup] };
      break;
    case 'compaction': {
      const previous = record.summaries.at(-1);
      // 同一段历史重复保存相同摘要时不重复追加。
      const unchanged = previous !== undefined
        && previous.text === mutation.entry.text
        && previous.coversThrough === mutation.entry.coversThrough;
      next = {
        ...record,
        effectiveHistory: mutation.effectiveHistory,
        summaries: unchanged ? record.summaries : [...record.summaries, mutation.entry],
        rounds: mutation.rounds,
        ...(mutation.recentFiles === undefined ? {} : { recentFiles: mutation.recentFiles }),
      };
      break;
    }
  }
  return { ...next, updatedAt: at };
}

function applyHistoryMutation(previous: ModelMessage[], mutation: HistoryMutation): ModelMessage[] {
  return mutation.mode === 'append'
    ? [...previous, ...mutation.messages]
    : mutation.messages;
}

/** 进行中轮次的 transcript 由起始位置之前的消息加上已观察内容重建。 */
function rebuildRoundTranscript(record: SessionRecord, round: SessionRecord['rounds'][number]): ModelMessage[] {
  const start = round.transcriptStart ?? record.transcript.length - 1;
  const observed = [
    ...(round.messages ?? []),
    ...(round.partialText ? [{ role: 'assistant' as const, content: round.partialText }] : []),
  ];
  // 已保存的压缩检查点覆盖位置不能因为本轮暂时更短而失效。
  if (round.compactedThrough !== undefined && start + 1 + observed.length < round.compactedThrough) return record.transcript;
  return [...record.transcript.slice(0, start + 1), ...observed];
}

function requireRoundIndex(record: SessionRecord, roundId: string): number {
  const index = record.rounds.findIndex((round) => round.id === roundId);
  if (index < 0) throw new Error('Invalid session event');
  return index;
}

function serializeEvent(seq: number, at: string, mutation: SessionMutation): string {
  const stored: StoredSessionEvent = { v: eventLogVersion, seq, at, type: mutation.type, data: mutation };
  return `${JSON.stringify(stored)}\n`;
}

async function readSessionState(home: string, conversationId: string, options: SessionLoadOptions = {}): Promise<SessionState> {
  const eventsPath = sessionEventsPath(home, conversationId);
  const snapshot = await readSnapshot(home, conversationId, options);
  let content: Buffer;
  let size = 0;
  try {
    const handle = await open(eventsPath, 'r');
    try {
      size = (await handle.stat()).size;
      const start = snapshot !== undefined && snapshot.byteOffset <= size ? snapshot.byteOffset : 0;
      const length = Math.max(0, size - start);
      content = Buffer.alloc(length);
      if (length > 0) await handle.read(content, 0, length, start);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw new AgentError('PROVIDER_ERROR', '无法读取会话记录。');
    if (snapshot !== undefined) throw corruptSessionError();
    return readLegacyState(home, conversationId);
  }
  if (content.length === 0) {
    // 快照恰好落在文件末尾时没有增量事件可回放，直接使用快照状态。
    if (snapshot !== undefined && size > 0) {
      return {
        record: snapshot.record,
        seq: snapshot.eventSeq,
        snapshotSeq: snapshot.eventSeq,
        eventsByteOffset: size,
        legacy: false,
        eventsEmpty: false,
      };
    }
    // 转换过程可能只创建了空文件；优先回退到仍存在的旧记录。
    const legacy = await readLegacyRecord(home, conversationId);
    if (legacy !== undefined) return { record: legacy, seq: 0, snapshotSeq: 0, eventsByteOffset: 0, legacy: true, eventsEmpty: true };
    throw corruptSessionError();
  }
  let record = snapshot?.record;
  let seq = snapshot?.eventSeq ?? 0;
  const lines = splitEventLines(content, options);
  for (const line of lines) {
    if (!line.trim()) continue;
    let stored: unknown;
    try {
      stored = JSON.parse(line);
    } catch {
      throw corruptSessionError();
    }
    if (!isStoredSessionEvent(stored)) throw corruptSessionError();
    if (stored.seq <= seq) continue;
    if (stored.seq !== seq + 1) throw corruptSessionError();
    if (record === undefined && stored.type !== 'create') throw corruptSessionError();
    if (record === undefined) {
      // 新事件日志必须从 create 开始；后续状态由快照或该行建立。
      if (stored.type !== 'create' || !isCreateMutation(stored.data)) throw corruptSessionError();
      record = normalizeRecord(stored.data.record, conversationId);
    } else {
      try {
        record = applySessionMutation(record, stored.data as SessionMutation, stored.at);
      } catch {
        throw corruptSessionError();
      }
    }
    seq = stored.seq;
  }
  if (record === undefined) throw corruptSessionError();
  return {
    record: normalizeRecord(record, conversationId),
    seq,
    snapshotSeq: snapshot?.eventSeq ?? 0,
    eventsByteOffset: size,
    legacy: false,
    eventsEmpty: false,
  };
}

function isCreateMutation(value: unknown): value is Extract<SessionMutation, { type: 'create' }> {
  if (typeof value !== 'object' || value === null) return false;
  const record = (value as { record?: unknown }).record;
  return (value as { type?: unknown }).type === 'create'
    && typeof record === 'object' && record !== null && !Array.isArray(record)
    // 旧事件可能带 Hook 配置：先剔除再校验，保持旧日志可恢复。
    && isSessionRecord(pruneSessionHookConfig(record as SessionRecord));
}

function splitEventLines(content: Buffer, options: SessionLoadOptions): string[] {
  const text = content.toString('utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
    return lines;
  }
  // 崩溃可能留下最后一条未写完的记录：跳过并允许后续追加时裁掉，之前完整记录照常恢复。
  const incomplete = lines.pop();
  if (incomplete !== undefined && incomplete.trim() !== '') {
    options.onWarning?.({ code: 'incomplete-tail', message: '会话记录末尾不完整，已跳过未完成的最后一条记录。' });
  }
  return lines;
}

async function readSnapshot(home: string, conversationId: string, options: SessionLoadOptions): Promise<SessionSnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(sessionSnapshotPath(home, conversationId), 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    options.onWarning?.({ code: 'snapshot-ignored', message: '会话快照无法读取，已回退到完整 JSONL 记录。' });
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isSessionSnapshot(value) || value.id !== conversationId) throw new Error('Invalid snapshot');
    return { ...value, record: normalizeRecord(value.record, conversationId) };
  } catch {
    options.onWarning?.({ code: 'snapshot-ignored', message: '会话快照格式无效，已回退到完整 JSONL 记录。' });
    return undefined;
  }
}

async function readLegacyState(home: string, conversationId: string): Promise<SessionState> {
  const record = await readLegacyRecord(home, conversationId);
  if (record === undefined) throw new AgentError('CONFIG_ERROR', `会话记录不存在：${conversationId}。`);
  return { record, seq: 0, snapshotSeq: 0, eventsByteOffset: 0, legacy: true, eventsEmpty: false };
}

async function readLegacyRecord(home: string, conversationId: string): Promise<SessionRecord | undefined> {
  const path = sessionLegacyRecordPath(home, conversationId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new AgentError('PROVIDER_ERROR', '无法读取会话记录。');
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid session');
    // 旧 record.json 可能含 Hook 配置：读取时先剔除，避免敏感命令随会话恢复。
    const session = pruneSessionHookConfig(value as SessionRecord);
    if (!isSessionRecord(session) || session.id !== conversationId) throw new Error('Invalid session');
    return normalizeRecord(session, conversationId);
  } catch {
    throw new AgentError('PROVIDER_ERROR', '会话记录格式无效或已损坏，未覆盖原记录。');
  }
}

/** 旧记录没有 recentFiles 字段或标题时补齐；不改变原始 record.json。 */
function normalizeRecord(value: SessionRecord, conversationId: string): SessionRecord {
  // 事件与快照里的旧记录同样剔除 Hook 配置，保证读出的会话不再携带命令正文。
  const session = pruneSessionHookConfig(value);
  if (!isSessionRecord(session) || session.id !== conversationId) throw corruptSessionError();
  return {
    ...session,
    recentFiles: session.recentFiles ?? [],
    title: session.title?.trim() ? session.title : deriveSessionTitle(session.transcript),
  };
}

function corruptSessionError(): AgentError {
  return new AgentError('PROVIDER_ERROR', '会话记录格式无效或已损坏，未覆盖原记录。');
}

async function writeLegacyConversion(home: string, conversationId: string, record: SessionRecord, emptyEventsFile: boolean): Promise<void> {
  const path = sessionEventsPath(home, conversationId);
  await prepareSessionDirectory(home, conversationId);
  const line = serializeEvent(1, record.updatedAt, { type: 'create', record });
  await writeEventLogLine(path, line, emptyEventsFile ? 'w' : 'wx');
}

async function writeEventLogLine(path: string, line: string, flag: 'wx' | 'w'): Promise<void> {
  await writeFile(path, line, { encoding: 'utf8', mode: 0o600, flag });
}

/** 若上次进程在写一行途中断，追加前裁掉未完成尾行，避免坏行夹在日志中间；返回裁剪后的字节数。 */
async function trimIncompleteTail(path: string): Promise<number> {
  const handle = await open(path, 'r+');
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return size;
    let position = size;
    let cut = 0;
    while (position > 0) {
      const chunkSize = Math.min(64 * 1024, position);
      const chunk = Buffer.alloc(chunkSize);
      await handle.read(chunk, 0, chunkSize, position - chunkSize);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        cut = position - chunkSize + newline + 1;
        break;
      }
      position -= chunkSize;
    }
    await truncate(path, cut);
    return cut;
  } finally {
    await handle.close();
  }
}

async function writeSnapshotIfDue(
  home: string,
  conversationId: string,
  record: SessionRecord,
  seq: number,
  byteOffset: number,
  snapshotSeq: number,
  force: boolean,
): Promise<void> {
  if (!force && seq - snapshotSeq < snapshotEventInterval) return;
  const directory = join(sessionStorageRoot(home), 'sessions', conversationId);
  const path = sessionSnapshotPath(home, conversationId);
  const temporaryPath = join(directory, `.snapshot.${randomUUID()}.tmp`);
  const snapshot: SessionSnapshot = { v: snapshotVersion, id: conversationId, eventSeq: seq, byteOffset, record };
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } catch {
    // 快照只是恢复缓存；写失败不影响已追加的事件日志。
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function prepareSessionDirectory(home: string, conversationId: string): Promise<void> {
  const directory = join(sessionStorageRoot(home), 'sessions', conversationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(sessionStorageRoot(home), 0o700);
  await chmod(join(sessionStorageRoot(home), 'sessions'), 0o700);
  await chmod(directory, 0o700);
}

function isStoredSessionEvent(value: unknown): value is StoredSessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<StoredSessionEvent>;
  return event.v === eventLogVersion
    && Number.isSafeInteger(event.seq) && event.seq! > 0
    && typeof event.at === 'string'
    && typeof event.type === 'string'
    && typeof event.data === 'object' && event.data !== null
    && (event.data as { type?: unknown }).type === event.type;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<SessionSnapshot>;
  const record = snapshot.record;
  return snapshot.v === snapshotVersion
    && typeof snapshot.id === 'string'
    && Number.isSafeInteger(snapshot.eventSeq) && snapshot.eventSeq! > 0
    && Number.isSafeInteger(snapshot.byteOffset) && snapshot.byteOffset! >= 0
    && typeof record === 'object' && record !== null && !Array.isArray(record)
    && isSessionRecord(pruneSessionHookConfig(record as SessionRecord));
}

/** Hook 配置不随会话持久化：读写记录时统一剔除会话级与轮次级 config 中的 Hook 字段。 */
function pruneSessionHookConfig(record: SessionRecord): SessionRecord {
  const config = typeof record.config === 'object' && record.config !== null
    ? withoutHookConfig(record.config)
    : record.config;
  const rounds = Array.isArray(record.rounds)
    ? record.rounds.map(pruneRoundHookConfig)
    : record.rounds;
  return { ...record, config, rounds };
}

function pruneRoundHookConfig(round: SessionRecord['rounds'][number]): SessionRecord['rounds'][number] {
  return typeof round?.config === 'object' && round.config !== null
    ? { ...round, config: withoutHookConfig(round.config) }
    : round;
}

/** 事件数据中的记录与轮次级配置同样在落盘前剔除 Hook 字段。 */
function pruneSessionMutation(mutation: SessionMutation): SessionMutation {
  switch (mutation.type) {
    case 'create':
    case 'record':
      return { ...mutation, record: pruneSessionHookConfig(mutation.record) };
    case 'round-start':
    case 'round-finish':
      return { ...mutation, round: pruneRoundHookConfig(mutation.round) };
    default:
      return mutation;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<SessionRecord>;
  const fields = ['version', 'id', 'title', 'workspace', 'createdAt', 'updatedAt', 'config', 'transcript', 'effectiveHistory', 'skillLoads', 'skillBodies', 'rounds', 'summaries', 'checkpoints', 'backups', 'recentFiles'];
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
    && (session.skillLoads === undefined || (Array.isArray(session.skillLoads)
      && session.skillLoads.every((name) => typeof name === 'string')))
    && (session.skillBodies === undefined || (typeof session.skillBodies === 'object' && session.skillBodies !== null
      && !Array.isArray(session.skillBodies) && Object.values(session.skillBodies).every((body) => typeof body === 'string')))
    && Array.isArray(session.rounds) && session.rounds.every(isRoundRecord)
    && Array.isArray(session.summaries) && session.summaries.every(isSummaryRecord)
    && session.summaries.every((summary, index) => summary.coversThrough <= session.transcript!.length
      && (index === 0 || summary.coversThrough >= session.summaries![index - 1]!.coversThrough))
    && Array.isArray(session.checkpoints) && session.checkpoints.every(isCheckpointRecord)
    && Array.isArray(session.backups) && session.backups.every(isBackupRecord)
    && (session.recentFiles === undefined
      || (Array.isArray(session.recentFiles) && session.recentFiles.every((file) => typeof file === 'string')));
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
  const fields = ['provider', 'model', 'apiKeyEnv', 'baseURL', 'workspace', 'timeoutMs', 'maxSteps', 'explore', 'context', 'mcp', 'bash', 'approval', 'permissions', 'observability'];
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
    && (config.observability === undefined || isObservabilityConfig(config.observability))
    && typeof config.approval === 'object' && config.approval !== null;
}

/** 会话配置只保存环境变量名与非敏感地址；凭据值不会出现在记录中。 */
function isObservabilityConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const observability = value as { langfuse?: unknown };
  if (!Object.keys(value).every((field) => field === 'langfuse')) return false;
  const langfuse = observability.langfuse;
  if (typeof langfuse !== 'object' || langfuse === null) return false;
  const record = langfuse as Record<string, unknown>;
  return Object.keys(record).every((field) => ['enabled', 'baseURL', 'publicKeyEnv', 'secretKeyEnv'].includes(field))
    && typeof record.enabled === 'boolean'
    && typeof record.baseURL === 'string'
    && typeof record.publicKeyEnv === 'string'
    && typeof record.secretKeyEnv === 'string';
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
  const summary = value as SessionRecord['summaries'][number];
  return typeof value === 'object' && value !== null
    && typeof summary.text === 'string'
    && summary.text.trim().length > 0
    && Number.isSafeInteger(summary.coversThrough)
    && summary.coversThrough >= 0
    && (summary.restoredMessages === undefined
      || (Number.isSafeInteger(summary.restoredMessages) && summary.restoredMessages >= 0));
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

function assertConversationId(conversationId: string): void {
  if (!conversationIdPattern.test(conversationId)) {
    throw new AgentError('CONFIG_ERROR', 'conversationId 仅允许 1–128 位字母、数字、下划线或连字符。');
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExist(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}