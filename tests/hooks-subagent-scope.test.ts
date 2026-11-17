import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { BackgroundAgentTasks } from '../src/tools/AgentTool/background-agent-tasks.js';
import { DEFAULT_SANDBOX, type ResolvedConfig } from '../src/services/settings/config.js';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureResponse, FixtureToolCall } from './helpers/local-openai-fixture.js';

const homes: string[] = [];
const workspaces: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Respond = (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>;

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function appendHook(file: string): { type: 'command'; command: string } {
  return { type: 'command', command: `cat >> ${file}; printf '\\n' >> ${file}` };
}

function eventHook(file: string, event: string): { type: 'command'; command: string } {
  return { type: 'command', command: `printf '${event}\\n' >> ${file}` };
}

async function jsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function setup(respond: Respond): Promise<{
  workspace: string;
  fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>;
  config: ResolvedConfig;
  transcriptPath: string;
}> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-subagent-')));
  workspaces.push(workspace);
  const fixture = await startLocalOpenAIModel(respond);
  fixtures.push(fixture);
  await writeFile(join(workspace, 'note.txt'), '存在内容');
  const transcriptPath = join(workspace, 'parent-record.json');
  const config: ResolvedConfig = {
    approval: { mode: 'auto', timeoutMs: 30_000 },
    permissions: { allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX },
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    baseURL: fixture.baseURL, workspace, timeoutMs: 5000, maxSteps: 6,
    hooks: {
      PreToolUse: [{ hooks: [appendHook('pre-inputs.jsonl')] }],
      PostToolUse: [{ hooks: [appendHook('post-inputs.jsonl')] }],
      PostToolUseFailure: [{ hooks: [appendHook('failure-inputs.jsonl')] }],
    },
  };
  return { workspace, fixture, config, transcriptPath };
}

describe('子 Agent 的 Hook 事件范围', () => {
  it('前台 general-purpose 的工具事件带 agent 身份，主 Agent 的委派调用不带', async () => {
    const { workspace, config, transcriptPath } = await setup((_request, index) => {
      if (index === 1) return { calls: [call('fp-delegate', 'agent', {
        description: '读取文件', prompt: '读取 note.txt 与缺失文件',
      })] };
      if (index === 2) return { calls: [call('fp-read-ok', 'read_file', { path: 'note.txt' })] };
      if (index === 3) return { calls: [call('fp-read-missing', 'read_file', { path: 'missing.txt' })] };
      if (index === 4) return { content: '子 Agent 完成读取。' };
      return { content: '主 Agent 完成。' };
    });

    await runAgent(config, '委派读取', {
      smokeTool: false, sessionId: 'parent-session', transcriptPath,
    });

    const pre = await jsonLines(join(workspace, 'pre-inputs.jsonl'));
    expect(pre.map(({ tool_name }) => tool_name)).toEqual(['agent', 'read_file', 'read_file']);
    expect(pre[0]).toMatchObject({
      session_id: 'parent-session', transcript_path: transcriptPath, tool_name: 'agent', tool_use_id: 'fp-delegate',
    });
    expect(pre[0]).not.toHaveProperty('agent_id');
    expect(pre[0]).not.toHaveProperty('agent_type');
    for (const entry of pre.slice(1)) {
      expect(entry).toMatchObject({
        session_id: 'parent-session',
        transcript_path: transcriptPath,
        agent_id: 'fp-delegate',
        agent_type: 'general-purpose',
      });
    }

    const post = await jsonLines(join(workspace, 'post-inputs.jsonl'));
    // 子 Agent 在委派工具返回前完成，因此它的 PostToolUse 先于父级的 agent 调用。
    expect(post.map(({ tool_name }) => tool_name)).toEqual(['read_file', 'agent']);
    expect(post.find(({ tool_name }) => tool_name === 'agent')).not.toHaveProperty('agent_id');
    expect(post.find(({ tool_name }) => tool_name === 'read_file')).toMatchObject({
      agent_id: 'fp-delegate', agent_type: 'general-purpose', tool_use_id: 'fp-read-ok',
    });

    const failures = await jsonLines(join(workspace, 'failure-inputs.jsonl'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      session_id: 'parent-session',
      agent_id: 'fp-delegate',
      agent_type: 'general-purpose',
      hook_event_name: 'PostToolUseFailure',
      tool_use_id: 'fp-read-missing',
      error_code: 'TOOL_EXECUTION_ERROR',
    });
  });

  it('Explore 的工具事件带 agent 身份并沿用父会话标识', async () => {
    const { workspace, config, transcriptPath } = await setup((_request, index) => {
      if (index === 1) return { calls: [call('ex-delegate', 'agent', {
        description: '调查代码', prompt: '读取 note.txt 并报告', subagent_type: 'Explore',
      })] };
      if (index === 2) return { calls: [call('ex-read', 'read_file', { path: 'note.txt' })] };
      if (index === 3) return { content: 'Explore 报告：内容存在。' };
      return { content: '主 Agent 完成。' };
    });

    await runAgent(config, '委派调查', {
      smokeTool: false, sessionId: 'parent-session', transcriptPath,
    });

    const pre = await jsonLines(join(workspace, 'pre-inputs.jsonl'));
    const readPre = pre.find(({ tool_name }) => tool_name === 'read_file');
    expect(readPre).toMatchObject({
      session_id: 'parent-session',
      transcript_path: transcriptPath,
      agent_id: 'ex-delegate',
      agent_type: 'Explore',
      tool_use_id: 'ex-read',
    });
    const post = await jsonLines(join(workspace, 'post-inputs.jsonl'));
    expect(post.find(({ tool_name }) => tool_name === 'read_file')).toMatchObject({
      agent_id: 'ex-delegate', agent_type: 'Explore',
    });
  });

  it('后台 general-purpose 的工具事件与前台一致', async () => {
    const { workspace, config, transcriptPath } = await setup((request) => {
      const userText = request.messages
        .filter(({ role }) => role === 'user')
        .map(({ content }) => content)
        .join('\n');
      if (userText.includes('任务：后台读取')) {
        return request.messages.some(({ role }) => role === 'tool')
          ? { content: '后台子 Agent 报告。' }
          : { calls: [call('bg-read', 'read_file', { path: 'note.txt' })] };
      }
      return request.messages.some(({ role }) => role === 'tool')
        ? { content: '主 Agent 完成。' }
        : { calls: [call('bg-delegate', 'agent', {
          description: '后台读取', prompt: '后台读取', background: true,
        })] };
    });
    const backgroundTasks = new BackgroundAgentTasks();

    await runAgent(config, '启动后台读取', {
      smokeTool: false, sessionId: 'parent-session', transcriptPath, backgroundTasks,
    });
    const pending = backgroundTasks.pendingStatuses();
    expect(pending).toHaveLength(1);
    await backgroundTasks.wait([pending[0]!.taskId]);

    const pre = await jsonLines(join(workspace, 'pre-inputs.jsonl'));
    expect(pre.find(({ tool_name }) => tool_name === 'agent')).not.toHaveProperty('agent_id');
    expect(pre.find(({ tool_name }) => tool_name === 'read_file')).toMatchObject({
      session_id: 'parent-session',
      transcript_path: transcriptPath,
      agent_id: 'bg-delegate',
      agent_type: 'general-purpose',
      tool_use_id: 'bg-read',
    });
    const post = await jsonLines(join(workspace, 'post-inputs.jsonl'));
    expect(post.find(({ tool_name }) => tool_name === 'read_file')).toMatchObject({
      agent_id: 'bg-delegate', agent_type: 'general-purpose',
    });
  });
});

describe('子 Agent 不重复触发会话级 Hook', () => {
  it('CLI 委派 Explore 时 SessionStart、UserPromptSubmit、Stop 各只运行一次', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-subagent-cli-')));
    const home = await realpath(await mkdtemp(join(tmpdir(), 'qhy-hooks-subagent-cli-home-')));
    workspaces.push(workspace);
    homes.push(home);
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('cli-delegate', 'agent', {
        description: '调查代码', prompt: '读取 note.txt 并报告', subagent_type: 'Explore',
      })] };
      if (index === 2) return { calls: [call('cli-read', 'read_file', { path: 'note.txt' })] };
      if (index === 3) return { content: 'Explore 报告：内容存在。' };
      return { content: '主 Agent 完成。' };
    });
    fixtures.push(fixture);
    await mkdir(join(workspace, '.agent'), { recursive: true });
    await writeFile(join(workspace, 'note.txt'), '存在内容');
    const log = 'events.log';
    await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
      model: 'hook-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'HOOK_TEST_KEY',
      timeoutMs: 3000,
      hooks: {
        SessionStart: [{ hooks: [eventHook(log, 'SessionStart')] }],
        UserPromptSubmit: [{ hooks: [eventHook(log, 'UserPromptSubmit')] }],
        PreToolUse: [{ hooks: [appendHook('pre-inputs.jsonl')] }],
        PostToolUse: [{ hooks: [appendHook('post-inputs.jsonl')] }],
        Stop: [{ hooks: [eventHook(log, 'Stop')] }],
      },
    }));

    const result = await startCLI({
      cwd: workspace,
      userDir: home,
      conversationId: 'subagent-scope-cli',
      input: '委派探索\n/exit\n',
      args: ['--trust-hooks'],
      env: { HOOK_TEST_KEY: 'hook-test-secret' },
    }).done;

    expect(result.code, result.stdout + result.stderr).toBe(0);
    const events = (await readFile(join(workspace, log), 'utf8')).trim().split('\n');
    expect(events.filter((event) => event === 'SessionStart')).toHaveLength(1);
    expect(events.filter((event) => event === 'UserPromptSubmit')).toHaveLength(1);
    expect(events.filter((event) => event === 'Stop')).toHaveLength(1);
    const pre = await jsonLines(join(workspace, 'pre-inputs.jsonl'));
    expect(pre.map(({ tool_name }) => tool_name).sort()).toEqual(['agent', 'read_file']);
    expect(pre.find(({ tool_name }) => tool_name === 'read_file')).toMatchObject({
      session_id: 'subagent-scope-cli',
      agent_id: 'cli-delegate',
      agent_type: 'Explore',
    });
    expect(pre.find(({ tool_name }) => tool_name === 'read_file')).not.toHaveProperty('agent_type', 'general-purpose');
  });
});