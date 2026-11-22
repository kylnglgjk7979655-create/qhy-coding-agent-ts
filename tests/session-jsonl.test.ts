import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendRoundMessages,
  appendRoundText,
  appendSessionEvent,
  createSession,
  finishSessionRound,
  listSessions,
  loadSession,
  saveCompactionCheckpoint,
  saveManualCompaction,
  sessionEventsPath,
  sessionLegacyRecordPath,
  sessionSnapshotPath,
  startSessionRound,
  type SessionLoadWarning,
  type SessionRecord,
} from '../src/services/session/conversations.js';
import { writeLegacySession } from './helpers/session-store.js';

const config = {
  provider: 'openai' as const,
  model: 'fixture-model',
  apiKeyEnv: 'TEST_API_KEY',
  workspace: '/work/project',
  timeoutMs: 60_000,
  maxSteps: 20,
  approval: { mode: 'auto' as const, rules: [], timeoutMs: 30_000 },
};

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qhy-jsonl-session-'));
  roots.push(root);
  return root;
}

async function eventLines(homeDirectory: string, id: string): Promise<string[]> {
  const raw = await readFile(sessionEventsPath(homeDirectory, id), 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('JSONL 会话保存', () => {
  it('新会话按事件追加 JSONL，完整历史可重建且不生成 record.json', async () => {
    const userHome = await home();
    const id = 'append-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    expect(await eventLines(userHome, id)).toHaveLength(1);

    const roundId = await startSessionRound(userHome, id, '第一轮需求', config);
    expect(await eventLines(userHome, id)).toHaveLength(2);

    const beforeFirstChunk = (await stat(sessionEventsPath(userHome, id))).size;
    await appendRoundText(userHome, id, roundId, '已观察到的部分输出');
    const afterFirstChunk = (await stat(sessionEventsPath(userHome, id))).size;
    // 追加一条流式文本不应重写完整历史：本次写入只增加一条事件大小。
    expect(afterFirstChunk - beforeFirstChunk).toBeLessThan(1_000);
    await appendRoundText(userHome, id, roundId, '，继续');
    expect(await eventLines(userHome, id)).toHaveLength(4);

    await appendRoundMessages(userHome, id, roundId, [{
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.txt' } }],
    } as unknown as ModelMessage]);

    const finalMessages = [
      { role: 'assistant', content: '已完成第一轮。' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { is_error: false, output: { content: 'A' } } }] },
    ] as unknown as ModelMessage[];
    await finishSessionRound(userHome, id, roundId, {
      status: 'succeeded',
      response: finalMessages,
      effectiveHistory: [{ role: 'user', content: '第一轮需求' }, ...finalMessages],
    });

    const lines = await eventLines(userHome, id);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { v: number; seq: number; type: string };
      expect(parsed.v).toBe(1);
      expect(parsed.type).toBeTruthy();
    }
    expect((JSON.parse(lines[0]!) as { type: string }).type).toBe('create');
    expect(lines.slice(1).map((line) => (JSON.parse(line) as { type: string }).type))
      .toEqual(['round-start', 'round-text', 'round-text', 'round-messages', 'round-finish']);
    await expect(readFile(sessionLegacyRecordPath(userHome, id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const record = await loadSession(userHome, id);
    expect(record.transcript).toEqual([{ role: 'user', content: '第一轮需求' }, ...finalMessages]);
    expect(record.effectiveHistory).toEqual([{ role: 'user', content: '第一轮需求' }, ...finalMessages]);
    expect(record.rounds[0]?.status).toBe('succeeded');
  });

  it('并发提交同一会话时事件序号严格递增且不丢事件', async () => {
    const userHome = await home();
    const id = 'concurrent-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '并发工具需求', config);

    // 并行工具结果会在同一 tick 内提交到同一会话，模拟并发写入。
    const toolCallIds = Array.from({ length: 12 }, (_, index) => `parallel-call-${index}`);
    await Promise.all(toolCallIds.map((toolCallId) => appendRoundMessages(userHome, id, roundId, [{
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input: { path: `${toolCallId}.txt` } }],
    } as unknown as ModelMessage])));

    const lines = await eventLines(userHome, id);
    const seqs = lines.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: lines.length }, (_, index) => index + 1));

    // 重复序号会让回放静默跳过事件；恢复记录必须包含全部并发提交。
    const record = await loadSession(userHome, id);
    const savedCalls = (record.rounds[0]?.messages ?? []).flatMap((message) => Array.isArray(message.content)
      ? message.content.flatMap((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call'
        ? [(part as { toolCallId?: string }).toolCallId] : [])
      : []);
    expect(savedCalls.sort()).toEqual([...toolCallIds].sort());
  });

  it('绝对、相对和符号链接路径别名指向同一会话时仍串行提交', async () => {
    const userHome = await home();
    const id = 'aliased-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '路径别名并发', config);

    // 同一实体会话的三种写法：绝对路径、相对当前目录、经由符号链接。
    const linkedHome = join(await home(), 'linked-home');
    await symlink(userHome, linkedHome, 'dir');
    const homes = [userHome, relative(process.cwd(), userHome), linkedHome];

    const toolCallIds = Array.from({ length: 12 }, (_, index) => `alias-call-${index}`);
    await Promise.all(toolCallIds.map((toolCallId, index) => appendRoundMessages(
      homes[index % homes.length]!, id, roundId, [{
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName: 'read_file', input: { path: `${toolCallId}.txt` } }],
      } as unknown as ModelMessage],
    )));

    const lines = await eventLines(userHome, id);
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq))
      .toEqual(Array.from({ length: lines.length }, (_, index) => index + 1));
    // 别名分裂队列会写出重复 seq，回放时静默丢弃其中一份，恢复记录因此缺少工具调用。
    const record = await loadSession(userHome, id);
    const savedCalls = (record.rounds[0]?.messages ?? []).flatMap((message) => Array.isArray(message.content)
      ? message.content.flatMap((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call'
        ? [(part as { toolCallId?: string }).toolCallId] : [])
      : []);
    expect(savedCalls.sort()).toEqual([...toolCallIds].sort());
  });

  it('会话目录尚不存在时仍可确定队列键，创建后通过别名继续提交', async () => {
    const userHome = await home();
    const linkedHome = join(await home(), 'new-linked-home');
    await symlink(userHome, linkedHome, 'dir');
    const id = 'created-through-alias';

    // 目录尚不存在：解析键时向上回退到已存在的 home，提交本身按既有语义报告会话不存在。
    await expect(appendSessionEvent(userHome, id, [{ role: 'user', content: '缺失' }]))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR' });

    await createSession(linkedHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '创建后提交', config);
    await appendRoundMessages(linkedHome, id, roundId, [{
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'after-alias-create', toolName: 'read_file', input: { path: 'a.txt' } }],
    } as unknown as ModelMessage]);

    const lines = await eventLines(userHome, id);
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq))
      .toEqual(Array.from({ length: lines.length }, (_, index) => index + 1));
    expect((await loadSession(userHome, id)).rounds[0]?.messages).toHaveLength(1);
  });

  it('不同会话的并发提交各自排队且互不丢失', async () => {
    const userHome = await home();
    const first = 'parallel-session-a';
    const second = 'parallel-session-b';
    await createSession(userHome, { id: first, workspace: config.workspace, config });
    await createSession(userHome, { id: second, workspace: config.workspace, config });
    const firstRound = await startSessionRound(userHome, first, '会话 A', config);
    const secondRound = await startSessionRound(userHome, second, '会话 B', config);

    // 两个会话各自并发提交，队列键必须按会话隔离，且各自序号仍严格递增。
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendRoundMessages(
      userHome,
      index % 2 === 0 ? first : second,
      index % 2 === 0 ? firstRound : secondRound,
      [{
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `session-call-${index}`, toolName: 'read_file', input: { path: `${index}.txt` } }],
      } as unknown as ModelMessage],
    )));

    for (const { id, expected } of [{ id: first, expected: 4 }, { id: second, expected: 4 }]) {
      const lines = await eventLines(userHome, id);
      expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq))
        .toEqual(Array.from({ length: lines.length }, (_, index) => index + 1));
      expect((await loadSession(userHome, id)).rounds[0]?.messages).toHaveLength(expected);
    }
  });

  it('单次提交失败不会阻塞同一会话的后续提交', async () => {
    const userHome = await home();
    const id = 'failed-commit-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '失败后续提交', config);

    // 失败的提交排在前面；队列必须放行后续提交，且失败本身不写入事件。
    const failing = appendRoundMessages(userHome, id, 'missing-round', []);
    const succeeding = appendRoundMessages(userHome, id, roundId, [{
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'after-failure', toolName: 'read_file', input: { path: 'after.txt' } }],
    } as unknown as ModelMessage]);
    await Promise.all([
      expect(failing).rejects.toMatchObject({ code: 'PROVIDER_ERROR' }),
      expect(succeeding).resolves.toBeUndefined(),
    ]);

    const lines = await eventLines(userHome, id);
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq))
      .toEqual(Array.from({ length: lines.length }, (_, index) => index + 1));
    expect(lines).toHaveLength(3);
    const record = await loadSession(userHome, id);
    expect(record.rounds[0]?.messages).toHaveLength(1);
  });

  it('旧 JSON 会话在首次打开时按需转换，之后继续追加且不批量迁移', async () => {
    const userHome = await home();
    const id = 'legacy-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '旧需求', config);
    await finishSessionRound(userHome, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '旧答复' }],
      effectiveHistory: [{ role: 'user', content: '旧需求' }, { role: 'assistant', content: '旧答复' }],
    });
    const legacy: SessionRecord = await loadSession(userHome, id);
    await writeLegacySession(userHome, legacy);
    const legacyRaw = await readFile(sessionLegacyRecordPath(userHome, id), 'utf8');
    await expect(readFile(sessionEventsPath(userHome, id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // 列目录只读，不触发旧会话转换。
    expect((await listSessions(userHome)).map(({ id: listedId }) => listedId)).toEqual([id]);
    await expect(readFile(sessionEventsPath(userHome, id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const converted = await loadSession(userHome, id);
    expect(converted.transcript).toEqual(legacy.transcript);
    expect(await eventLines(userHome, id)).toHaveLength(1);
    // 原始 record.json 保留为兼容备份，不被改写。
    expect(await readFile(sessionLegacyRecordPath(userHome, id), 'utf8')).toBe(legacyRaw);

    const nextRound = await startSessionRound(userHome, id, '转换后继续', config);
    await finishSessionRound(userHome, id, nextRound, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '新答复' }],
      effectiveHistory: [
        ...converted.effectiveHistory,
        { role: 'user', content: '转换后继续' },
        { role: 'assistant', content: '新答复' },
      ],
    });
    const resumed = await loadSession(userHome, id);
    expect(resumed.transcript).toEqual([
      { role: 'user', content: '旧需求' },
      { role: 'assistant', content: '旧答复' },
      { role: 'user', content: '转换后继续' },
      { role: 'assistant', content: '新答复' },
    ]);
    expect(resumed.rounds.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
    // 转换后继续写入 JSONL，旧文件保持原样。
    expect(await readFile(sessionLegacyRecordPath(userHome, id), 'utf8')).toBe(legacyRaw);
    expect((await eventLines(userHome, id)).length).toBeGreaterThan(1);
  });

  it('快照加速恢复且不截断 JSONL，摘要与压缩检查点续聊后仍正确', async () => {
    const userHome = await home();
    const id = 'snapshot-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '长会话需求', config);
    for (let index = 0; index < 70; index += 1) await appendRoundText(userHome, id, roundId, 'x');
    await finishSessionRound(userHome, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: 'x'.repeat(70) }],
      effectiveHistory: [
        { role: 'user', content: '长会话需求' },
        { role: 'assistant', content: 'x'.repeat(70) },
      ],
    });

    const eventsPath = sessionEventsPath(userHome, id);
    const beforeSnapshot = await eventLines(userHome, id);
    const snapshot = JSON.parse(await readFile(sessionSnapshotPath(userHome, id), 'utf8')) as {
      eventSeq: number;
      byteOffset: number;
      record: SessionRecord;
    };
    expect(snapshot.eventSeq).toBeGreaterThanOrEqual(64);
    expect(snapshot.byteOffset).toBeGreaterThan(0);
    expect(snapshot.record.id).toBe(id);

    await saveManualCompaction(userHome, id, {
      effectiveHistory: [{ role: 'user', content: '[对话摘要]\n快照摘要_MARKER' }],
      summary: { text: '快照摘要_MARKER' },
    });
    const afterCompaction = await loadSession(userHome, id);
    expect(afterCompaction.summaries).toEqual([{ text: '快照摘要_MARKER', coversThrough: 2 }]);
    expect(JSON.stringify(afterCompaction.effectiveHistory)).toContain('快照摘要_MARKER');

    await appendSessionEvent(userHome, id, [
      { role: 'user', content: '续聊需求' },
      { role: 'assistant', content: '续聊答复' },
    ]);
    const afterAppendLines = await eventLines(userHome, id);
    expect(afterAppendLines.length).toBeGreaterThan(beforeSnapshot.length);
    // 快照不截断原文：压缩和续聊前的事件日志行仍在文件中。
    expect(afterAppendLines[0]).toContain('"type":"create"');
    expect(afterAppendLines).toContainEqual(expect.stringContaining('快照摘要_MARKER'));

    // 破坏快照之前的日志前缀；恢复仍从快照开始，证明快照用于加速而不是重放全部历史。
    const buffer = Buffer.from(await readFile(eventsPath));
    for (let index = 0; index < Math.min(16, buffer.length); index += 1) buffer[index] = 0x23;
    await writeFile(eventsPath, buffer);
    const recovered = await loadSession(userHome, id);
    expect(recovered.summaries).toEqual([{ text: '快照摘要_MARKER', coversThrough: 2 }]);
    expect(JSON.stringify(recovered.effectiveHistory)).toContain('快照摘要_MARKER');
    expect(JSON.stringify(recovered.effectiveHistory)).toContain('续聊需求');
    expect(recovered.transcript.at(-1)).toEqual({ role: 'assistant', content: '续聊答复' });
    expect((await readFile(eventsPath)).length).toBe(buffer.length);

    // 快照之后继续追加，下一次恢复读取尾部的增量事件。
    await appendSessionEvent(userHome, id, [{ role: 'user', content: '再续一句' }]);
    const again = await loadSession(userHome, id);
    expect(JSON.stringify(again.effectiveHistory)).toContain('再续一句');
  });

  it('活动轮次压缩检查点随快照恢复，续聊保留摘要与覆盖边界', async () => {
    const userHome = await home();
    const id = 'checkpoint-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '检查点需求', config);
    await appendRoundText(userHome, id, roundId, '已观察内容');
    const summary = '[对话摘要]\n检查点摘要_MARKER';
    const entry = await saveCompactionCheckpoint(userHome, id, roundId, {
      effectiveHistory: [{ role: 'user', content: summary }],
      summary: { text: '检查点摘要_MARKER' },
    });
    expect(entry.coversThrough).toBe(2);

    await finishSessionRound(userHome, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '本轮完成' }],
      effectiveHistory: [{ role: 'user', content: summary }, { role: 'assistant', content: '本轮完成' }],
      summaries: [entry],
    });
    const resumed = await loadSession(userHome, id);
    expect(resumed.summaries).toEqual([entry]);
    expect(resumed.rounds[0]?.compactedThrough).toBe(2);
    expect(JSON.stringify(resumed.effectiveHistory)).toContain('检查点摘要_MARKER');

    const nextRound = await startSessionRound(userHome, id, '检查点后续聊', config);
    await finishSessionRound(userHome, id, nextRound, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '续聊完成' }],
      effectiveHistory: [
        ...resumed.effectiveHistory,
        { role: 'user', content: '检查点后续聊' },
        { role: 'assistant', content: '续聊完成' },
      ],
    });
    const final = await loadSession(userHome, id);
    expect(final.summaries).toEqual([entry]);
    expect(JSON.stringify(final.effectiveHistory)).toContain('检查点摘要_MARKER');
    expect(JSON.stringify(final.effectiveHistory)).toContain('续聊完成');
    expect(final.transcript.map(({ content }) => content)).toContain('检查点后续聊');
  });

  it('跳过不完整尾行并提示，后续追加先裁掉未完成记录', async () => {
    const userHome = await home();
    const id = 'tail-session';
    await createSession(userHome, { id, workspace: config.workspace, config });
    const roundId = await startSessionRound(userHome, id, '完整需求', config);
    await finishSessionRound(userHome, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '完整答复' }],
      effectiveHistory: [{ role: 'user', content: '完整需求' }, { role: 'assistant', content: '完整答复' }],
    });
    const completeLines = await eventLines(userHome, id);
    const fragment = '{"v":1,"seq":99,"at":"2026-01-01T00:00:00.000Z","type":"round-text","data":{"type":"round-text","roundId":"broken"';
    await writeFile(sessionEventsPath(userHome, id), `${completeLines.join('\n')}\n${fragment}`, 'utf8');

    const warnings: SessionLoadWarning[] = [];
    const recovered = await loadSession(userHome, id, { onWarning: (warning) => warnings.push(warning) });
    expect(warnings.map(({ code }) => code)).toEqual(['incomplete-tail']);
    expect(warnings[0]?.message).toContain('不完整');
    expect(recovered.transcript).toEqual([{ role: 'user', content: '完整需求' }, { role: 'assistant', content: '完整答复' }]);

    await appendSessionEvent(userHome, id, [{ role: 'user', content: '尾行之后的续聊' }]);
    const afterAppend = await readFile(sessionEventsPath(userHome, id), 'utf8');
    expect(afterAppend).not.toContain('"roundId":"broken"');
    expect(afterAppend.endsWith('\n')).toBe(true);
    for (const line of afterAppend.split('\n').filter((value) => value.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const nextWarnings: SessionLoadWarning[] = [];
    const again = await loadSession(userHome, id, { onWarning: (warning) => nextWarnings.push(warning) });
    expect(nextWarnings).toEqual([]);
    expect(again.transcript.at(-1)).toEqual({ role: 'user', content: '尾行之后的续聊' });
    expect((await readdir(join(userHome, '.qhy-coding-agents', 'sessions', id))).sort())
      .toEqual(['events.jsonl']);
  });
});