import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, finishSessionRound, loadSession, saveSession, sessionEventsPath, sessionSnapshotPath, startSessionRound, type SessionRecord } from '../src/services/session/conversations.js';
import { readStoredSession, writeLegacySession } from './helpers/session-store.js';

const webSearch = { provider: 'tavily' as const, apiKeyEnv: 'TAVILY_API_KEY', timeoutMs: 30_000, maxResults: 5 };

/** 模拟旧版本把网络搜索凭据值写进会话配置的记录。 */
function withWebSearchCredential(record: SessionRecord): SessionRecord {
  return { ...record, config: { ...record.config, webSearchApiKey: 'legacy-secret' } as SessionRecord['config'] };
}

describe('user-level session storage', () => {
  let userDirectory: string | undefined;

  afterEach(async () => {
    if (userDirectory) await rm(userDirectory, { recursive: true, force: true });
    userDirectory = undefined;
  });

  async function makeUserDirectory(): Promise<string> {
    userDirectory = await mkdtemp(join(tmpdir(), 'qhy-session-store-'));
    return userDirectory;
  }

  it('creates a durable session bound to its workspace without storing credential values', async () => {
    const home = await makeUserDirectory();
    const config = {
      provider: 'openai' as const,
      model: 'fixture-model',
      apiKeyEnv: 'TEST_API_KEY',
      workspace: '/work/project',
      timeoutMs: 60_000,
      maxSteps: 20,
      approval: { mode: 'auto' as const, rules: [], timeoutMs: 30_000 },
    };

    const created = await createSession(home, {
      id: 'durable-session', workspace: '/work/project', config,
    });
    const restarted = await loadSession(home, 'durable-session');

    expect(created.id).toBe('durable-session');
    expect(restarted).toEqual(created);
    expect(restarted.workspace).toBe('/work/project');
    expect(restarted.config.apiKeyEnv).toBe('TEST_API_KEY');
    expect(await readFile(sessionEventsPath(home, 'durable-session'), 'utf8'))
      .not.toContain('credential-value');
  });

  it('preserves Explore options when a session is resumed', async () => {
    const home = await makeUserDirectory();
    const config = {
      provider: 'openai' as const,
      model: 'fixture-model',
      apiKeyEnv: 'TEST_API_KEY',
      workspace: '/work/project',
      timeoutMs: 60_000,
      maxSteps: 20,
      explore: { model: 'explore-model', loadRootAgents: true },
      approval: { mode: 'auto' as const, rules: [], timeoutMs: 30_000 },
    };

    await createSession(home, { id: 'explore-session', workspace: '/work/project', config });

    expect((await loadSession(home, 'explore-session')).config.explore)
      .toEqual({ model: 'explore-model', loadRootAgents: true });
  });

  it('derives and persists a title from the first user message, while upgrading older records on save', async () => {
    const home = await makeUserDirectory();
    const config = {
      provider: 'openai' as const,
      model: 'fixture-model',
      apiKeyEnv: 'TEST_API_KEY',
      workspace: '/work/project',
      timeoutMs: 60_000,
      maxSteps: 20,
      approval: { mode: 'auto' as const, rules: [], timeoutMs: 30_000 },
    };
    const session = await createSession(home, { id: 'titled-session', workspace: '/work/project', config });
    await startSessionRound(home, session.id, '  第一个需求\n请修改文件  ', config);
    await startSessionRound(home, session.id, '后续需求不得覆盖标题', config);

    const stored = await readStoredSession(home, session.id);
    expect(stored.title).toBe('第一个需求 请修改文件');
    const restarted = await loadSession(home, session.id);
    expect(restarted.title).toBe('第一个需求 请修改文件');

    // 旧记录没有 title 时按 transcript 推导，并在下一次保存时持久化。
    delete stored.title;
    await writeLegacySession(home, stored);
    const legacy = await loadSession(home, session.id);
    expect(legacy.title).toBe('第一个需求 请修改文件');
    await saveSession(home, legacy);
    expect((await readStoredSession(home, session.id)).title).toBe('第一个需求 请修改文件');
  });

  it('rejects a damaged record and leaves it unchanged', async () => {
    const home = await makeUserDirectory();
    const path = sessionEventsPath(home, 'damaged-session');
    await createSession(home, {
      id: 'damaged-session', workspace: '/work/project', config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    await writeFile(path, '{truncated');

    await expect(loadSession(home, 'damaged-session')).rejects.toThrow(/会话记录.*损坏/);
    await expect(createSession(home, {
      id: 'damaged-session', workspace: '/work/other', config: {
        provider: 'openai', model: 'new-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/other',
        timeoutMs: 60_000, maxSteps: 20, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    })).rejects.toThrow(/会话记录.*损坏/);
    expect(await readFile(path, 'utf8')).toBe('{truncated');
  });

  it('round-trips a session configured with WebSearch', async () => {
    const home = await makeUserDirectory();
    await createSession(home, {
      id: 'websearch-session', workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });

    const restarted = await loadSession(home, 'websearch-session');
    expect(restarted.config.webSearch).toEqual(webSearch);
  });

  it('loads sessions written with the former WebSearch credential field without exposing it', async () => {
    const home = await makeUserDirectory();
    await createSession(home, {
      id: 'legacy-websearch-session', workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    // 旧版本会把网络搜索凭据值写入 create 事件；模拟这类既有会话。
    const path = sessionEventsPath(home, 'legacy-websearch-session');
    const [line] = (await readFile(path, 'utf8')).split('\n');
    const event = JSON.parse(line!) as { data: { record: { config: Record<string, unknown> } } };
    event.data.record.config.webSearchApiKey = 'legacy-secret';
    await writeFile(path, `${JSON.stringify(event)}\n`);

    const restarted = await loadSession(home, 'legacy-websearch-session');
    expect(restarted.config.webSearch).toEqual(webSearch);
    expect(restarted.config).not.toHaveProperty('webSearchApiKey');
    expect(JSON.stringify(restarted)).not.toContain('legacy-secret');

    // 读取路径同时清洗旧事件日志，明文凭据不能继续留在磁盘上。
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('legacy-secret');
    expect(persisted).not.toContain('webSearchApiKey');
    const [scrubbedLine] = persisted.split('\n');
    expect(JSON.parse(scrubbedLine!)).toMatchObject({ seq: 1, type: 'create' });
    expect((JSON.parse(scrubbedLine!) as { data: { record: { config: Record<string, unknown> } } })
      .data.record.config.webSearch).toEqual(webSearch);
  });

  it('continues a scrubbed legacy session without persisting the former credential again', async () => {
    const home = await makeUserDirectory();
    const id = 'resumed-legacy-websearch-session';
    await createSession(home, {
      id, workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    const path = sessionEventsPath(home, id);
    const [line] = (await readFile(path, 'utf8')).split('\n');
    const event = JSON.parse(line!) as { data: { record: { config: Record<string, unknown> } } };
    event.data.record.config.webSearchApiKey = 'legacy-secret';
    await writeFile(path, `${JSON.stringify(event)}\n`);

    const restarted = await loadSession(home, id);
    const roundId = await startSessionRound(home, id, '清洗后继续', restarted.config);
    await finishSessionRound(home, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '继续成功' }],
      effectiveHistory: [{ role: 'user', content: '清洗后继续' }, { role: 'assistant', content: '继续成功' }],
    });

    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('legacy-secret');
    expect(persisted).not.toContain('webSearchApiKey');
    const resumed = await loadSession(home, id);
    expect(resumed.transcript).toContainEqual({ role: 'user', content: '清洗后继续' });
    expect(resumed.config.webSearch).toEqual(webSearch);
  });

  it('scrubs the former WebSearch credential from legacy round events', async () => {
    const home = await makeUserDirectory();
    const id = 'legacy-round-websearch-session';
    await createSession(home, {
      id, workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    const roundId = await startSessionRound(home, id, '旧轮次', {
      provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
      timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
    });
    await finishSessionRound(home, id, roundId, {
      status: 'succeeded',
      response: [{ role: 'assistant', content: '旧答复' }],
      effectiveHistory: [{ role: 'user', content: '旧轮次' }, { role: 'assistant', content: '旧答复' }],
    });
    // 旧版本的轮次配置同样可能带着凭据值；逐行注入，覆盖 round-start 与 round-finish。
    const path = sessionEventsPath(home, id);
    const lines = (await readFile(path, 'utf8')).split('\n');
    const injected = lines.map((line) => {
      if (!line) return line;
      const event = JSON.parse(line) as { data?: { round?: { config?: Record<string, unknown> } } };
      if (event.data?.round?.config) event.data.round.config.webSearchApiKey = 'legacy-secret';
      return JSON.stringify(event);
    });
    await writeFile(path, `${injected.join('\n')}`);

    const restarted = await loadSession(home, id);
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('legacy-secret');
    expect(persisted).not.toContain('webSearchApiKey');
    expect(restarted.rounds[0]?.config?.webSearch).toEqual(webSearch);
    expect(restarted.transcript).toEqual([{ role: 'user', content: '旧轮次' }, { role: 'assistant', content: '旧答复' }]);
  });

  it('ignores the former WebSearch credential field stored in a session snapshot', async () => {
    const home = await makeUserDirectory();
    const id = 'snapshot-websearch-session';
    await createSession(home, {
      id, workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    // 快照覆盖完整事件日志时不回放 create 事件，凭据必须在快照校验和归一化时剔除。
    const events = await readFile(sessionEventsPath(home, id));
    await writeFile(sessionSnapshotPath(home, id), JSON.stringify({
      v: 1, id, eventSeq: 1, byteOffset: events.byteLength, record: withWebSearchCredential(await loadSession(home, id)),
    }));

    const restarted = await loadSession(home, id);
    expect(restarted.config.webSearch).toEqual(webSearch);
    expect(restarted.config).not.toHaveProperty('webSearchApiKey');
    expect(JSON.stringify(restarted)).not.toContain('legacy-secret');
    // 快照重建/读取时同样清洗旧凭据字段，磁盘上的快照不再保留明文。
    const snapshotRaw = await readFile(sessionSnapshotPath(home, id), 'utf8');
    expect(snapshotRaw).not.toContain('legacy-secret');
    expect(snapshotRaw).not.toContain('webSearchApiKey');
  });

  it('ignores the former WebSearch credential field in a legacy record file', async () => {
    const home = await makeUserDirectory();
    const id = 'legacy-websearch-record';
    await createSession(home, {
      id, workspace: '/work/project',
      config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, webSearch, approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      },
    });
    await writeLegacySession(home, withWebSearchCredential(await loadSession(home, id)));

    const restarted = await loadSession(home, id);
    expect(restarted.config.webSearch).toEqual(webSearch);
    expect(restarted.config).not.toHaveProperty('webSearchApiKey');
    expect(JSON.stringify(restarted)).not.toContain('legacy-secret');
  });
});
