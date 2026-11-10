import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, loadConfig, loggableConfig, restoreSessionConfig } from '../src/services/settings/config.js';

describe('configuration', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'qhy-config-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('uses defaults, resolves the workspace and references an environment variable', async () => {
    const config = await loadConfig({ cwd, workspace: '.', env: { OPENAI_API_KEY: 'test-secret' } });
    expect(config).toMatchObject({ provider: 'openai', maxSteps: 20, timeoutMs: 60_000, apiKey: 'test-secret' });
    expect(config.explore).toBeUndefined();
    expect(config.workspace).toMatch(/qhy-config-/);
    expect(loggableConfig(config)).not.toHaveProperty('apiKey');
    expect(JSON.stringify(loggableConfig(config))).not.toContain('test-secret');
  });

  it('resolves config and workspace relative to cwd, with CLI override taking priority', async () => {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({ apiKeyEnv: 'CUSTOM_KEY' }));
    const config = await loadConfig({ cwd, workspace: '.', env: { CUSTOM_KEY: 'key' } });
    expect(config.apiKey).toBe('key');
  });

  it('按用户、项目、项目本地顺序合并 settings，权限数组去重且其他数组整体替换', async () => {
    const home = join(cwd, 'home');
    const project = join(cwd, 'project');
    await mkdir(join(home, '.agent'), { recursive: true });
    await mkdir(join(project, '.agent'), { recursive: true });
    await writeFile(join(home, '.agent', 'settings.json'), JSON.stringify({
      model: 'user-model', workspace: '../project', permissions: { allow: ['Read', 'Write'], deny: ['Bash(rm *)'] },
      mcp: { servers: [{ name: 'user', url: 'https://user.example/mcp' }] },
    }));
    await writeFile(join(project, '.agent', 'settings.json'), JSON.stringify({
      model: 'project-model', permissions: { allow: ['Read', 'Glob'], ask: ['Write'] },
      mcp: { servers: [{ name: 'project', url: 'https://project.example/mcp' }] },
    }));
    await writeFile(join(project, '.agent', 'settings.local.json'), JSON.stringify({
      model: 'local-model', permissions: { allow: ['Read'], ask: ['Bash(npm test)'] },
    }));

    const config = await loadConfig({ cwd: home, env: { HOME: home, USERPROFILE: home, OPENAI_API_KEY: 'key' } });

    expect(config.model).toBe('local-model');
    expect(config.workspace).toBe(project);
    expect(config.approval.mode).toBe('default');
    expect(config.permissions).toEqual({
      allow: ['Read', 'Write', 'Glob'], ask: ['Write', 'Bash(npm test)'], deny: ['Bash(rm *)'],
    });
    expect(config.mcp?.servers).toEqual([{ name: 'project', url: 'https://project.example/mcp', headers: {} }]);
  });

  it('命令行工作区覆盖用户级工作区，且不向父目录发现项目 settings', async () => {
    const home = join(cwd, 'home');
    const parent = join(cwd, 'parent');
    const preferred = join(cwd, 'preferred');
    const selected = join(cwd, 'selected');
    await mkdir(join(home, '.agent'), { recursive: true });
    await mkdir(join(parent, '.agent'), { recursive: true });
    await mkdir(join(parent, 'child'), { recursive: true });
    await mkdir(preferred);
    await mkdir(selected);
    await writeFile(join(home, '.agent', 'settings.json'), JSON.stringify({ workspace: '../preferred', model: 'user-model' }));
    await writeFile(join(parent, '.agent', 'settings.json'), JSON.stringify({ model: 'parent-model' }));

    const config = await loadConfig({
      cwd: home, workspace: '../selected',
      env: { HOME: home, USERPROFILE: home, OPENAI_API_KEY: 'key' },
    });
    const child = await loadConfig({
      cwd: join(parent, 'child'), home: join(cwd, 'empty-home'),
      env: { OPENAI_API_KEY: 'key' },
    });

    expect(config.workspace).toBe(selected);
    expect(config.model).toBe('user-model');
    expect(child.model).not.toBe('parent-model');
  });

  it('项目设置不能重定向工作区，且报告非法权限规则', async () => {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({ workspace: '../other' }));
    await expect(loadConfig({ cwd, env: { OPENAI_API_KEY: 'key' } })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });

    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read('] } }));
    await expect(loadConfig({ cwd, env: { OPENAI_API_KEY: 'key' } })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('恢复会话时按其实际工作区重新加载当前 settings', async () => {
    const saved = configSchema.parse({ workspace: cwd, model: 'saved-model', apiKeyEnv: 'OPENAI_API_KEY' });
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({ model: 'current-model' }));

    const config = await restoreSessionConfig(saved, { OPENAI_API_KEY: 'key' });

    expect(config.workspace).toBe(cwd);
    expect(config.model).toBe('current-model');
  });

  it.each([
    { maxSteps: 0 }, { maxSteps: 1.5 }, { maxSteps: 101 },
    { timeoutMs: 0 }, { timeoutMs: '100' }, { timeoutMs: 3_600_001 },
    { provider: 'unsupported' }, { model: ' ' }, { apiKey: 'plaintext-key' },
    { apiKeyEnv: 'invalid-name' }, { baseURL: 'ftp://example.com' },
    { baseURL: 'https://user:password@example.com' },
    { baseURL: 'https://example.com/?api_key=secret' },
    { explore: { model: ' ' } }, { explore: { loadRootAgents: 'true' } },
    { explore: { unsupported: true } },
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

  it('接受有效的 Explore 模型与根目录指令选项', () => {
    expect(configSchema.parse({ explore: { model: ' explore-model ', loadRootAgents: true } }).explore)
      .toEqual({ model: 'explore-model', loadRootAgents: true });
    expect(configSchema.parse({ explore: {} }).explore?.loadRootAgents).toBe(false);
  });

  it('在加载配置阶段拒绝无效的 Explore 选项', async () => {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({ explore: { model: ' ' } }));

    await expect(loadConfig({ cwd, workspace: '.', env: { OPENAI_API_KEY: 'key' } }))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  it('rejects nonexistent workspaces and files used as directories', async () => {
    await writeFile(join(cwd, 'file'), 'text');
    for (const workspace of ['missing', 'file']) {
      await expect(loadConfig({ cwd, workspace, env: { OPENAI_API_KEY: 'key' } }))
        .rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    }
  });

  it('ignores legacy config with a migration warning and rejects malformed settings', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ model: 'legacy-model' }));
    const config = await loadConfig({ cwd, env: { OPENAI_API_KEY: 'key' } });
    expect(config.model).not.toBe('legacy-model');
    expect(config.migrationWarnings?.[0]).toContain('agent.config.json');
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), '{');
    await expect(loadConfig({ cwd, env: {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
