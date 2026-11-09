import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

describe('只读 Explore 委派', () => {
  let workspace: string;
  let outside: string;
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  });

  it('通过 agent 启动独立 Explore，多轮搜索读取后把报告交回主 Agent', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await writeFile(join(workspace, 'module.ts'), 'export const answer = 42;\n');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '查找 answer 的定义', prompt: '查找 answer 的定义并报告文件位置。' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'explore-grep', type: 'function', function: {
        name: 'grep', arguments: JSON.stringify({ pattern: 'answer' }),
      } }] };
      if (index === 3) return { calls: [{ id: 'explore-read', type: 'function', function: {
        name: 'read_file', arguments: JSON.stringify({ path: 'module.ts' }),
      } }] };
      if (index === 4) return { content: '结论：answer 定义为 42，位置是 module.ts:1；调查已完成。' };
      return { content: '根据调查，answer 是 42，定义位于 module.ts:1。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };

    const result = await runAgent(config, '检查这个模块', { smokeTool: false,
      history: [{ role: 'assistant', content: '主对话中的私密历史' }],
    });

    expect(result.text).toContain('module.ts:1');
    expect(fixture.requests).toHaveLength(5);
    const exploreSearch = fixture.requests[1]!;
    expect(exploreSearch.messages.filter(({ role }) => role === 'user')).toHaveLength(1);
    expect(exploreSearch.messages.find(({ role }) => role === 'user')).toMatchObject({ content: expect.stringContaining('查找 answer 的定义并报告文件位置。') });
    expect(JSON.stringify(exploreSearch.messages)).not.toContain('主对话中的私密历史');
    expect(exploreSearch.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    expect(exploreSearch.tools.map(({ function: fn }) => fn.name).sort()).toEqual(['glob', 'grep', 'read_file']);
    expect(fixture.requests[2]!.messages.some(({ role }) => role === 'tool')).toBe(true);
    expect(fixture.requests[3]!.messages.some(({ role }) => role === 'tool')).toBe(true);
    const returnedReport = fixture.requests[4]!.messages.find(({ role }) => role === 'tool')!.content;
    expect(returnedReport).toContain('answer 定义为 42');
  });

  it('同一主对话中的每次 Explore 都从空白上下文开始', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'first-explore', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查甲', prompt: '调查标记甲' }) } }] };
      if (index === 2) return { content: '甲报告含有内部标记 FIRST_EXPLORE_ONLY。' };
      if (index === 3) return { calls: [{ id: 'second-explore', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查乙', prompt: '调查标记乙' }) } }] };
      if (index === 4) return { content: '乙报告。' };
      return { content: '两次调查已完成。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };

    await runAgent(config, '完成两次调查', { smokeTool: false });

    expect(fixture.requests).toHaveLength(5);
    const firstExplore = fixture.requests[1]!;
    const secondExplore = fixture.requests[3]!;
    expect(firstExplore.messages.at(-1)!.content).toContain('调查标记甲');
    expect(secondExplore.messages.map(({ content }) => content).join('\n')).toContain('调查标记乙');
    expect(JSON.stringify(secondExplore.messages)).not.toContain('FIRST_EXPLORE_ONLY');
    expect(secondExplore.messages.map(({ role }) => role)).toEqual(['system', 'user']);
  });

  it.each([
    ['unknown type', { description: '调查代码', prompt: '检查实现', type: 'Builder' }, 'TOOL_EXECUTION_ERROR', '可用类型：Explore'],
    ['missing required prompt', { description: '调查代码' }, 'INVALID_TOOL_ARGUMENTS', '工具参数无效'],
  ])('对 %s 返回可识别的错误', async (_caseName, input, errorCode, message) => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'invalid-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify(input) } }] }
      : { content: '已收到委派错误。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };

    await runAgent(config, '试着委派', { smokeTool: false });

    expect(fixture.requests).toHaveLength(2);
    const result = JSON.parse(fixture.requests[1]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(result).toMatchObject({ is_error: true, error: { code: errorCode, message: expect.stringContaining(message) } });
  });

  it('外层 agent 拒绝策略阻止 Explore 请求', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'denied-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查实现' }) } }] }
      : { content: '权限拒绝已处理。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'model', rules: [{ toolName: 'agent', action: 'deny' }], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };
    const events: string[] = [];

    await runAgent(config, '试着委派', { smokeTool: false, onToolEvent: (event) => events.push(`${event.toolName}:${event.status}`) });

    expect(fixture.requests).toHaveLength(2);
    expect(JSON.parse(fixture.requests[1]!.messages.find(({ role }) => role === 'tool')!.content)).toMatchObject({
      is_error: true, error: { code: 'PERMISSION_DENIED' },
    });
    expect(events).toEqual(['agent:rejected']);
  });

  it('外层 agent 的审批要求生效', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'approved-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查实现' }) } }] }
      : index === 2 ? { content: '已完成只读调查。' } : { content: '已根据报告回答。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'human', rules: [{ toolName: 'agent', action: 'ask' }], timeoutMs: 30_000, humanTimeoutMs: 1000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };
    const approvalCalls: string[] = [];

    await runAgent(config, '试着委派', { smokeTool: false, approvalControl: async (call) => {
      approvalCalls.push(call.toolName);
      return 'approve';
    } });

    expect(approvalCalls).toEqual(['agent']);
    expect(fixture.requests).toHaveLength(3);
  });

  it('Explore 的 read_file 不能通过符号链接读取工作区外文件', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    outside = await mkdtemp(join(tmpdir(), 'qhy-explore-outside-'));
    await writeFile(join(outside, 'secret.txt'), '工作区外秘密');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'secret-link.txt'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'boundary-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '检查边界', prompt: '读取 secret-link.txt 并报告结果' }) } }] };
      if (index === 2) return { calls: [{ id: 'boundary-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'secret-link.txt' }) } }] };
      if (index === 3) return { content: '读取失败，目标不在工作区内。' };
      return { content: 'Explore 未能读取工作区外文件。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'model', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 5,
    };

    await runAgent(config, '检查文件边界', { smokeTool: false });

    const internalResult = JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(internalResult).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(fixture.requests[1]!.tools.map(({ function: fn }) => fn.name).sort()).toEqual(['glob', 'grep', 'read_file']);
  });
});
