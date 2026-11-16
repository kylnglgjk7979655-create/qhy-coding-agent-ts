import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configSchema,
  loadConfig,
  loggableConfig,
  persistableSessionConfig,
} from '../src/services/settings/config.js';
import {
  SESSION_START_SOURCES,
  hookQueryField,
  matchesHookMatcher,
  parseHookMatcher,
} from '../src/services/hooks/hooks-config.js';
import { createSession, loadSession, sessionRecordPath, startSessionRound } from '../src/services/session/conversations.js';
import type { ModelConfig } from '../src/services/settings/config.js';
import { tempDir } from './helpers/temp-dir.js';

const commandHook = (command: string, timeoutMs?: number) => ({
  type: 'command' as const,
  command,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

describe('Hook 配置模型与分层合并', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await tempDir('qhy-hooks-config-'); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  async function writeLayer(directory: string, name: string, value: unknown): Promise<void> {
    await mkdir(join(directory, '.agent'), { recursive: true });
    await writeFile(join(directory, '.agent', name), JSON.stringify(value));
  }

  it('接受六个事件、command 类型、可选 timeoutMs 与顶层 disableAllHooks 默认值', () => {
    const parsed = configSchema.parse({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [commandHook('echo start')] }],
        UserPromptSubmit: [{ hooks: [commandHook('echo prompt', 1_000)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('echo pre')] }],
        PostToolUse: [{ matcher: 'Bash|Read', hooks: [commandHook('echo post')] }],
        PostToolUseFailure: [{ matcher: '^mcp_', hooks: [commandHook('echo failure')] }],
        Stop: [{ hooks: [commandHook('echo stop', 600_000)] }],
      },
    });

    expect(Object.keys(parsed.hooks ?? {})).toHaveLength(6);
    expect(parsed.disableAllHooks).toBe(false);
    expect(parsed.hooks?.PostToolUse?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'echo post' });
  });

  it('三层 hooks 按用户级、项目级、项目本地顺序拼接，完全重复项保留第一条并输出 warning', async () => {
    const home = join(cwd, 'home');
    const project = join(cwd, 'project');
    await writeLayer(home, 'settings.json', {
      disableAllHooks: true,
      hooks: {
        SessionStart: [{ hooks: [commandHook('user-session')] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('shared-bash', 1_000)] }],
      },
    });
    await writeLayer(project, 'settings.json', {
      hooks: {
        SessionStart: [{ hooks: [commandHook('project-session')] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [commandHook('shared-bash', 1_000)] },
          { matcher: 'Bash', hooks: [commandHook('project-bash')] },
        ],
      },
    });
    await writeLayer(project, 'settings.local.json', {
      disableAllHooks: false,
      hooks: {
        SessionStart: [{ hooks: [commandHook('user-session')] }],
        Stop: [{ hooks: [commandHook('local-stop')] }],
      },
    });

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = await loadConfig({
      cwd: project, home, env: { HOME: home, USERPROFILE: home, OPENAI_API_KEY: 'key' },
    });
    stderr.mockRestore();

    expect(config.disableAllHooks).toBe(false);
    expect(config.hooks?.SessionStart?.flatMap((group) => group.hooks.map((hook) => hook.command)))
      .toEqual(['user-session', 'project-session']);
    expect(config.hooks?.PreToolUse?.flatMap((group) => group.hooks.map((hook) => hook.command)))
      .toEqual(['shared-bash', 'project-bash']);
    expect(config.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('local-stop');
    expect(config.migrationWarnings?.join('\n')).toContain('Hook 配置重复');
  });

  it.each([
    ['未知事件', { hooks: { SessionEnd: [] } }],
    ['未知类型', { hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'echo x' }] }] } }],
    ['空 command', { hooks: { Stop: [{ hooks: [{ type: 'command', command: '   ' }] }] } }],
    ['空 hooks 数组', { hooks: { Stop: [{ hooks: [] }] } }],
    ['timeoutMs 为零', { hooks: { Stop: [{ hooks: [commandHook('echo x', 0)] }] } }],
    ['timeoutMs 为负', { hooks: { Stop: [{ hooks: [commandHook('echo x', -1)] }] } }],
    ['timeoutMs 超过上限', { hooks: { Stop: [{ hooks: [commandHook('echo x', 600_001)] }] } }],
    ['timeoutMs 非整数', { hooks: { Stop: [{ hooks: [commandHook('echo x', 1.5)] }] } }],
    ['非法 matcher 正则', { hooks: { PreToolUse: [{ matcher: '(', hooks: [commandHook('echo x')] }] } }],
    ['未知 matcher 组字段', { hooks: { Stop: [{ matcher: '', hooks: [commandHook('echo x')], extra: true }] } }],
  ])('加载配置时以 CONFIG_ERROR 拒绝：%s', async (_label, value) => {
    await writeLayer(cwd, 'settings.json', value);

    await expect(loadConfig({ cwd, env: { OPENAI_API_KEY: 'key' } }))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR', exitCode: 2 });
  });

  it('旧版 agent.config.json 只产生迁移提示，其中 hooks 不参与加载', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [commandHook('legacy-stop')] }] },
    }));

    const config = await loadConfig({ cwd, env: { OPENAI_API_KEY: 'key' } });

    expect(config.hooks).toBeUndefined();
    expect(config.migrationWarnings?.join('\n')).toContain('agent.config.json');
  });

  it('matcher 解析覆盖精确名、A|B 名单、正则、空串与星号', () => {
    expect(parseHookMatcher('Bash')).toEqual({ kind: 'exact', name: 'Bash' });
    expect(parseHookMatcher('Bash|Edit')).toEqual({ kind: 'list', names: ['Bash', 'Edit'] });
    expect(parseHookMatcher('^mcp_')).toMatchObject({ kind: 'regex' });
    expect(parseHookMatcher('')).toEqual({ kind: 'all' });
    expect(parseHookMatcher('*')).toEqual({ kind: 'all' });
    expect(parseHookMatcher(undefined)).toEqual({ kind: 'all' });
    expect(() => parseHookMatcher('(')).toThrow();
  });

  it('按事件解析 match query，并且无 query 的事件不做 matcher 过滤', () => {
    expect(hookQueryField('SessionStart')).toBe('source');
    expect(hookQueryField('PreToolUse')).toBe('tool_name');
    expect(hookQueryField('PostToolUse')).toBe('tool_name');
    expect(hookQueryField('PostToolUseFailure')).toBe('tool_name');
    expect(hookQueryField('UserPromptSubmit')).toBeUndefined();
    expect(hookQueryField('Stop')).toBeUndefined();

    expect(SESSION_START_SOURCES).toEqual(['startup', 'resume']);
    expect(matchesHookMatcher('Bash', 'Bash')).toBe(true);
    expect(matchesHookMatcher('Bash|Edit', 'Edit')).toBe(true);
    expect(matchesHookMatcher('^mcp_', 'mcp_server_tool')).toBe(true);
    expect(matchesHookMatcher('', 'anything')).toBe(true);
    expect(matchesHookMatcher('*', 'anything')).toBe(true);
    expect(matchesHookMatcher('Bash', 'Read')).toBe(false);
    expect(matchesHookMatcher('Bash', undefined)).toBe(true);
  });

  it('会话记录与可记录配置不包含 hooks 和 disableAllHooks', async () => {
    await writeLayer(cwd, 'settings.json', {
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [commandHook('secret-hook-command')] }] },
    });
    const home = join(cwd, 'home');
    const config = await loadConfig({ cwd, home, env: { HOME: home, OPENAI_API_KEY: 'key' } });

    const logged = loggableConfig(config);
    expect(logged).not.toHaveProperty('hooks');
    expect(logged).not.toHaveProperty('disableAllHooks');
    expect(JSON.stringify(logged)).not.toContain('secret-hook-command');

    const session = await createSession(home, {
      id: 'hooks-not-persisted', workspace: cwd, config: persistableSessionConfig(config),
    });
    const raw = JSON.parse(await readFile(sessionRecordPath(home, 'hooks-not-persisted'), 'utf8')) as Record<string, unknown>;
    expect(raw.config).not.toHaveProperty('hooks');
    expect(raw.config).not.toHaveProperty('disableAllHooks');
    expect(JSON.stringify(raw)).not.toContain('secret-hook-command');
    expect(session.config).not.toHaveProperty('hooks');
  });

  it('写入与恢复旧快照时都忽略 hooks', async () => {
    const home = join(cwd, 'home');
    const config: ModelConfig = {
      provider: 'openai', model: 'fixture', apiKeyEnv: 'OPENAI_API_KEY', workspace: cwd,
      timeoutMs: 60_000, maxSteps: 20, approval: { mode: 'default', rules: [], timeoutMs: 30_000 },
    };
    const withHooks = { ...config, hooks: { Stop: [{ hooks: [commandHook('should-not-be-stored')] }] }, disableAllHooks: true };
    await createSession(home, { id: 'legacy-hooks', workspace: cwd, config: withHooks as unknown as ModelConfig });
    const roundId = await startSessionRound(home, 'legacy-hooks', 'hello', withHooks as unknown as ModelConfig);
    const path = sessionRecordPath(home, 'legacy-hooks');

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      config: Record<string, unknown>; rounds: Array<{ id: string; config?: Record<string, unknown> }>;
    };
    expect(written.config).not.toHaveProperty('hooks');
    expect(written.rounds.find((round) => round.id === roundId)?.config).not.toHaveProperty('hooks');

    // 模拟旧版本快照：即使记录里已经有 hooks，恢复时也直接忽略。
    written.config.hooks = { Stop: [{ hooks: [commandHook('stale-hook')] }] };
    written.config.disableAllHooks = true;
    const staleRound = written.rounds.find((round) => round.id === roundId);
    if (staleRound) {
      staleRound.config = { ...staleRound.config, hooks: { Stop: [{ hooks: [commandHook('stale-round-hook')] }] } };
    }
    await writeFile(path, JSON.stringify(written));

    const restored = await loadSession(home, 'legacy-hooks');
    expect(restored.config).not.toHaveProperty('hooks');
    expect(restored.config).not.toHaveProperty('disableAllHooks');
    expect(restored.rounds.find((round) => round.id === roundId)?.config).not.toHaveProperty('hooks');
  });
});