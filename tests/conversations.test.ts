import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, loadSession, sessionStorageRoot } from '../src/conversations.js';

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
      approval: { mode: 'model' as const, rules: [], timeoutMs: 30_000 },
    };

    const created = await createSession(home, {
      id: 'durable-session', workspace: '/work/project', config,
    });
    const restarted = await loadSession(home, 'durable-session');

    expect(created.id).toBe('durable-session');
    expect(restarted).toEqual(created);
    expect(restarted.workspace).toBe('/work/project');
    expect(restarted.config.apiKeyEnv).toBe('TEST_API_KEY');
    expect(await readFile(join(sessionStorageRoot(home), 'sessions', 'durable-session', 'record.json'), 'utf8'))
      .not.toContain('credential-value');
  });

  it('rejects a damaged record and leaves it unchanged', async () => {
    const home = await makeUserDirectory();
    const path = join(sessionStorageRoot(home), 'sessions', 'damaged-session', 'record.json');
    await createSession(home, {
      id: 'damaged-session', workspace: '/work/project', config: {
        provider: 'openai', model: 'fixture-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/project',
        timeoutMs: 60_000, maxSteps: 20, approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      },
    });
    await writeFile(path, '{truncated');

    await expect(loadSession(home, 'damaged-session')).rejects.toThrow(/会话记录.*损坏/);
    await expect(createSession(home, {
      id: 'damaged-session', workspace: '/work/other', config: {
        provider: 'openai', model: 'new-model', apiKeyEnv: 'TEST_API_KEY', workspace: '/work/other',
        timeoutMs: 60_000, maxSteps: 20, approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      },
    })).rejects.toThrow(/会话记录.*损坏/);
    expect(await readFile(path, 'utf8')).toBe('{truncated');
  });
});
