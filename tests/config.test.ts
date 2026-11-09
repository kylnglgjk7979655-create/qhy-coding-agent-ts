import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, loadConfig, loggableConfig } from '../src/services/settings/config.js';

describe('configuration', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'qhy-config-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('uses defaults, resolves the workspace and references an environment variable', async () => {
    const config = await loadConfig({ cwd, workspace: '.', env: { OPENAI_API_KEY: 'test-secret' } });
    expect(config).toMatchObject({ provider: 'openai', maxSteps: 20, timeoutMs: 60_000, apiKey: 'test-secret' });
    expect(config.workspace).toMatch(/qhy-config-/);
    expect(loggableConfig(config)).not.toHaveProperty('apiKey');
    expect(JSON.stringify(loggableConfig(config))).not.toContain('test-secret');
  });

  it('resolves config and workspace relative to cwd, with CLI override taking priority', async () => {
    await writeFile(join(cwd, 'custom.json'), JSON.stringify({ workspace: 'missing', apiKeyEnv: 'CUSTOM_KEY' }));
    const config = await loadConfig({ cwd, configPath: 'custom.json', workspace: '.', env: { CUSTOM_KEY: 'key' } });
    expect(config.apiKey).toBe('key');
  });

  it.each([
    { maxSteps: 0 }, { maxSteps: 1.5 }, { maxSteps: 101 },
    { timeoutMs: 0 }, { timeoutMs: '100' }, { timeoutMs: 3_600_001 },
    { provider: 'unsupported' }, { model: ' ' }, { apiKey: 'plaintext-key' },
    { apiKeyEnv: 'invalid-name' }, { baseURL: 'ftp://example.com' },
    { baseURL: 'https://user:password@example.com' },
    { baseURL: 'https://example.com/?api_key=secret' },
  ])('rejects invalid or unknown configuration: %j', (raw) => {
    expect(configSchema.safeParse(raw).success).toBe(false);
  });

  it('clearly rejects missing credentials', async () => {
    await expect(loadConfig({ cwd, workspace: '.', env: {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR', exitCode: 2 });
  });

  it('上下文默认保留两轮，阈值八成且目标五成，容量和回答预留有明确默认值', () => {
    expect(configSchema.parse({ context: {} }).context).toEqual({
      capacityTokens: 128_000, answerReserveTokens: 8192,
      triggerRatio: 0.8, targetRatio: 0.5, keepRecentTurns: 2,
    });
  });

  it('rejects nonexistent workspaces and files used as directories', async () => {
    await writeFile(join(cwd, 'file'), 'text');
    for (const workspace of ['missing', 'file']) {
      await expect(loadConfig({ cwd, workspace, env: { OPENAI_API_KEY: 'key' } }))
        .rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    }
  });

  it('rejects an explicit missing config and malformed JSON', async () => {
    await expect(loadConfig({ cwd, configPath: 'missing.json', env: {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await writeFile(join(cwd, 'agent.config.json'), '{');
    await expect(loadConfig({ cwd, env: {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
