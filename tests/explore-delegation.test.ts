import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { BackgroundAgentTasks } from '../src/tools/AgentTool/background-agent-tasks.js';
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

  it('省略类型时启动独立 general-purpose，上下文隔离并沿用工具拒绝策略', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-general-purpose-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-general-purpose', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '创建结果文件', prompt: '尝试创建 result.txt' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'denied-subagent-write', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: '不应写入' }),
      } }] };
      if (index === 3) return { content: '写入被拒绝，未创建文件。' };
      return { content: '子 Agent 已报告权限拒绝。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [{ toolName: 'write_file', action: 'deny' }], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };

    await runAgent(config, '请完成文件任务', { smokeTool: false,
      history: [{ role: 'assistant', content: '主对话私有历史标记' }],
    });

    expect(fixture.requests).toHaveLength(4);
    const child = fixture.requests[1]!;
    expect(child.tools.map(({ function: fn }) => fn.name)).toEqual(expect.arrayContaining(['Bash', 'write_file', 'read_file']));
    expect(child.tools.map(({ function: fn }) => fn.name)).not.toContain('agent');
    expect(child.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    expect(JSON.stringify(child.messages)).not.toContain('主对话私有历史标记');
    expect(child.messages[0]!.content).toContain('同一批');
    const rejected = JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(rejected).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    await expect(readFile(join(workspace, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('general-purpose 的写入调用通过外层人工审批控制后执行', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-general-purpose-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-approved-write', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '创建结果文件', prompt: '创建 result.txt' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'approved-subagent-write', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: '已批准写入' }),
      } }] };
      if (index === 3) return { content: '文件已创建。' };
      return { content: '子 Agent 已创建文件。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000, humanTimeoutMs: 1000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };
    const approvals: string[] = [];

    await runAgent(config, '请创建文件', { smokeTool: false, approvalControl: async (call) => {
      approvals.push(call.toolName);
      return 'approve';
    } });

    expect(approvals).toEqual(['write_file']);
    await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('已批准写入');
  });

  it('general-purpose 子 Agent 写入沿用主轮次文件检查点回调', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-general-purpose-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-checkpoint-write', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '创建结果文件', prompt: '创建 result.txt' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'subagent-checkpoint-write', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: '子 Agent 内容' }),
      } }] };
      if (index === 3) return { content: '文件已创建。' };
      return { content: '子 Agent 已创建文件。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [{ toolName: 'write_file', action: 'allow' }], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };
    const snapshots: string[] = [];

    await runAgent(config, '请创建文件', { smokeTool: false, onBeforeWrite: async ({ path, existed }) => {
      snapshots.push(`${path}:${existed}`);
    } });

    expect(snapshots).toEqual(['result.txt:false']);
    await expect(readFile(join(workspace, 'result.txt'), 'utf8')).resolves.toBe('子 Agent 内容');
  });

  it('子 Agent 创建文件后，主 Agent 不能以过期的缺失状态覆盖它', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-general-purpose-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-create', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '创建共享结果', prompt: '创建 shared.txt' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'child-create', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'shared.txt', content: '子 Agent 版本' }),
      } }] };
      if (index === 3) return { content: '文件已创建。' };
      if (index === 4) return { calls: [{ id: 'parent-overwrite', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'shared.txt', content: '主 Agent 覆盖' }),
      } }] };
      return { content: '已处理。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [{ toolName: 'write_file', action: 'allow' }], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 8,
    };

    await runAgent(config, '创建后继续处理共享文件', { smokeTool: false });

    const parentResult = fixture.requests.flatMap(({ messages }) => messages)
      .find((message) => message.role === 'tool' && 'tool_call_id' in message && message.tool_call_id === 'parent-overwrite')!.content;
    expect(JSON.parse(parentResult)).toMatchObject({ is_error: true, error: { message: expect.stringContaining('冲突') } });
    expect(await readFile(join(workspace, 'shared.txt'), 'utf8')).toBe('子 Agent 版本');
  });

  it('并发 Agent 创建同一文件时只有首个受控写入成功', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-general-purpose-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [
        { id: 'delegate-a', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '创建文件 A', prompt: '创建 shared.txt，写入 A' }) } },
        { id: 'delegate-b', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '创建文件 B', prompt: '创建 shared.txt，写入 B' }) } },
      ] };
      if (index === 2 || index === 3) return { calls: [{ id: `child-write-${index}`, type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'shared.txt', content: `Agent ${index}` }),
      } }] };
      return { content: '已完成。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [{ toolName: 'write_file', action: 'allow' }], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 8,
    };

    await runAgent(config, '并发创建同一文件', { smokeTool: false });

    const results = fixture.requests.flatMap(({ messages }) => messages)
      .filter((message) => message.role === 'tool' && 'tool_call_id' in message
        && (message.tool_call_id === 'child-write-2' || message.tool_call_id === 'child-write-3'))
      .map((message) => JSON.parse(message.content));
    expect(results.filter(({ is_error }: { is_error: boolean }) => !is_error)).toHaveLength(1);
    expect(results.filter(({ error }: { error?: { message: string } }) => error?.message.includes('冲突'))).toHaveLength(1);
    expect(await readFile(join(workspace, 'shared.txt'), 'utf8')).toMatch(/^Agent [23]$/);
  });

  it('通过 agent 启动独立 Explore，多轮搜索读取后把报告交回主 Agent', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await writeFile(join(workspace, 'module.ts'), 'export const answer = 42;\n');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '查找 answer 的定义', prompt: '查找 answer 的定义并报告文件位置。', subagent_type: 'Explore' }),
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
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
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

  it.each([
    { name: '默认不加载根目录指令并使用主模型', explore: undefined, callModel: undefined, expectedModel: 'fixture', includeRoot: false },
    { name: '配置加载根目录指令并使用 Explore 模型', explore: { model: 'explore-config-model', loadRootAgents: true }, callModel: undefined, expectedModel: 'explore-config-model', includeRoot: true },
    { name: '单次调用模型覆盖配置模型', explore: { model: 'explore-config-model', loadRootAgents: true }, callModel: 'explore-call-model', expectedModel: 'explore-call-model', includeRoot: true },
  ])('$name', async ({ explore, callModel, expectedModel, includeRoot }) => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await mkdir(join(workspace, 'nested'), { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'ROOT_EXPLORE_INSTRUCTIONS');
    await writeFile(join(workspace, 'nested', 'AGENTS.md'), 'NESTED_EXPLORE_INSTRUCTIONS');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'configured-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({
        description: '调查配置', prompt: '检查配置行为', subagent_type: 'Explore', ...(callModel === undefined ? {} : { model: callModel }),
      }) } }] }
      : { content: index === 2 ? '配置调查完成。' : '已根据报告回答。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
      ...(explore === undefined ? {} : { explore }),
    };

    await runAgent(config, '委派配置调查', { smokeTool: false });

    expect(fixture.requests[1]!.model).toBe(expectedModel);
    const instructions = fixture.requests[1]!.messages[0]!.content;
    expect(instructions.includes('ROOT_EXPLORE_INSTRUCTIONS')).toBe(includeRoot);
    expect(instructions).not.toContain('NESTED_EXPLORE_INSTRUCTIONS');
  });

  it('开启根目录指令但文件缺失时仍可完成调查', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'missing-agents-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({
        description: '调查缺失指令', prompt: '检查项目', subagent_type: 'Explore',
      }) } }] }
      : { content: '调查完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
      explore: { loadRootAgents: true },
    };

    const result = await runAgent(config, '委派缺失指令调查', { smokeTool: false });

    expect(result.text).toContain('调查完成');
    expect(fixture.requests).toHaveLength(3);
  });

  it('同一主对话中的每次 Explore 都从空白上下文开始', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'first-explore', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查甲', prompt: '调查标记甲', subagent_type: 'Explore' }) } }] };
      if (index === 2) return { content: '甲报告含有内部标记 FIRST_EXPLORE_ONLY。' };
      if (index === 3) return { calls: [{ id: 'second-explore', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查乙', prompt: '调查标记乙', subagent_type: 'Explore' }) } }] };
      if (index === 4) return { content: '乙报告。' };
      return { content: '两次调查已完成。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
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
    ['unknown type', { description: '调查代码', prompt: '检查实现', subagent_type: 'Builder' }, 'TOOL_EXECUTION_ERROR', '可用类型：general-purpose、Explore'],
    ['missing required prompt', { description: '调查代码' }, 'INVALID_TOOL_ARGUMENTS', '工具参数无效'],
  ])('对 %s 返回可识别的错误', async (_caseName, input, errorCode, message) => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'invalid-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify(input) } }] }
      : { content: '已收到委派错误。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
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
      ? { calls: [{ id: 'denied-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查实现', subagent_type: 'Explore' }) } }] }
      : { content: '权限拒绝已处理。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [{ toolName: 'agent', action: 'deny' }], timeoutMs: 30_000 },
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
      ? { calls: [{ id: 'approved-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查实现', subagent_type: 'Explore' }) } }] }
      : index === 2 ? { content: '已完成只读调查。' } : { content: '已根据报告回答。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [{ toolName: 'agent', action: 'ask' }], timeoutMs: 30_000, humanTimeoutMs: 1000 },
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

  it('Explore 读取工作区外文件经审批后遵守统一权限', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    outside = await mkdtemp(join(tmpdir(), 'qhy-explore-outside-'));
    await writeFile(join(outside, 'secret.txt'), '工作区外秘密');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'secret-link.txt'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'boundary-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '检查边界', prompt: '读取 secret-link.txt 并报告结果', subagent_type: 'Explore' }) } }] };
      if (index === 2) return { calls: [{ id: 'boundary-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'secret-link.txt' }) } }] };
      if (index === 3) return { content: '读取失败，目标不在工作区内。' };
      return { content: 'Explore 未能读取工作区外文件。' };
    }, () => ({ content: 'approve' }));
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 5,
    };

    await runAgent(config, '检查文件边界', { smokeTool: false });

    expect(fixture.approvalRequests).toHaveLength(1);
    expect(JSON.stringify(fixture.approvalRequests[0]!.messages)).toContain(join(outside, 'secret.txt'));
    const internalResult = JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(internalResult).toMatchObject({ is_error: false, output: { content: '工作区外秘密' } });
    expect(fixture.requests[1]!.tools.map(({ function: fn }) => fn.name).sort()).toEqual(['glob', 'grep', 'read_file']);
  });

  it('Explore 搜索按统一权限规则审批并将自身调查上下文交给审批模型', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await writeFile(join(workspace, 'module.ts'), 'export const guarded = true;\n');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'permission-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: '检查受保护搜索', prompt: '搜索 guarded 并报告位置', subagent_type: 'Explore' }) } }] };
      if (index === 2) return { calls: [{ id: 'permission-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'guarded' }) } }] };
      if (index === 3) return { content: '搜索被权限拒绝。' };
      if (index === 4) return { content: '搜索被权限拒绝。' };
      return { content: 'Explore 报告搜索被拒绝。' };
    }, () => ({ content: 'deny' }));
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      permissions: { allow: [], ask: ['Grep'], deny: [] },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };

    await runAgent(config, '检查受保护数据', { smokeTool: false,
      history: [{ role: 'assistant', content: '父会话私密历史' }],
    });

    expect(fixture.approvalRequests).toHaveLength(1);
    expect(JSON.stringify(fixture.approvalRequests[0]!.messages)).toContain('搜索 guarded');
    expect(JSON.stringify(fixture.approvalRequests[0]!.messages)).not.toContain('父会话私密历史');
    expect(JSON.stringify(fixture.approvalRequests[0]!.messages)).toContain('grep');
    expect(fixture.requests).toHaveLength(4);
    const denied = JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(denied).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
    expect(fixture.requests[1]!.tools.map(({ function: fn }) => fn.name).sort()).toEqual(['glob', 'grep', 'read_file']);
  });

  it('批量执行只读工具，单项失败后继续调查并要求报告说明失败影响', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await writeFile(join(workspace, 'module.ts'), 'export const answer = 42;\n');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-after-failure', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查 answer', prompt: '查找 answer 的定义', subagent_type: 'Explore' }),
      } }] };
      if (index === 2) return { calls: [
        { id: 'failed-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing.ts' }) } },
        { id: 'followup-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.ts' }) } },
        { id: 'followup-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'answer' }) } },
      ] };
      if (index === 3) return { content: '找到了 module.ts，但 missing.ts 读取失败，因此该文件内容未能核实。' };
      return { content: '调查已完成，missing.ts 的读取失败限制已说明。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 6,
    };

    await runAgent(config, '调查 answer', { smokeTool: false });

    const resumed = fixture.requests[2]!;
    const results = resumed.messages.filter(({ role }) => role === 'tool');
    expect(results.map(({ content }) => JSON.parse(content).is_error)).toEqual([true, false, false]);
    expect(results[1]!.content).toContain('module.ts');
    expect(results[2]!.content).toContain('answer');
    expect(fixture.requests[1]!.tools).toHaveLength(3);
    expect(fixture.requests[1]!.messages[0]!.content).toContain('失败');
    expect(JSON.parse(fixture.requests[3]!.messages.find(({ role }) => role === 'tool')!.content).output.report)
      .toContain('missing.ts 读取失败');
  });

  it('Explore 只公布只读工具，并拒绝写入、命令、远程服务和子 Agent 调用', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-boundary', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '检查权限边界', prompt: '确认 Explore 工具权限', subagent_type: 'Explore' }),
      } }] };
      if (index === 2) return { calls: [
        { id: 'forbidden-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'forbidden.txt', content: 'no' }) } },
        { id: 'forbidden-bash', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'touch forbidden.txt' }) } },
        { id: 'forbidden-mcp', type: 'function', function: { name: 'mcp_remote__write', arguments: '{}' } },
        { id: 'forbidden-agent', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ description: 'nested', prompt: 'nested' }) } },
      ] };
      if (index === 3) return { content: '所有未公布工具均被拒绝，未执行写入或委派。' };
      return { content: '权限边界已确认。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 5,
    };

    await runAgent(config, '检查 Explore 权限', { smokeTool: false });

    expect(fixture.requests[1]!.tools.map(({ function: fn }) => fn.name).sort()).toEqual(['glob', 'grep', 'read_file']);
    const results = fixture.requests[2]!.messages.filter(({ role }) => role === 'tool');
    expect(results).toHaveLength(4);
    expect(results.map(({ content }) => JSON.parse(content).error)).toEqual([
      expect.stringContaining("unavailable tool 'write_file'"),
      expect.stringContaining("unavailable tool 'Bash'"),
      expect.stringContaining("unavailable tool 'mcp_remote__write'"),
      expect.stringContaining("unavailable tool 'agent'"),
    ]);
    await expect(readFile(join(workspace, 'forbidden.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('搜索结果被截断时允许缩小范围，系统提示要求报告限制', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    await mkdir(join(workspace, 'many'), { recursive: true });
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(join(workspace, 'many', `file-${index}.ts`), 'const value = 1;\n')));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-truncated-search', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '检查搜索结果', prompt: '搜索并核实目标定义', subagent_type: 'Explore' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'wide-search', type: 'function', function: {
        name: 'glob', arguments: JSON.stringify({ pattern: '*.ts', path: 'many' }),
      } }] };
      if (index === 3) return { calls: [{ id: 'narrow-search', type: 'function', function: {
        name: 'glob', arguments: JSON.stringify({ pattern: 'file-000.ts', path: 'many' }),
      } }] };
      if (index === 4) return { content: '缩小到 src 后找到目标；首次全局搜索被截断，结论仅覆盖缩小范围。' };
      return { content: '已根据部分调查回答。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 7,
    };

    await runAgent(config, '检查搜索', { smokeTool: false });

    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requests[1]!.messages[0]!.content).toContain('截断');
    expect(fixture.requests[1]!.messages[0]!.content).toContain('缩小');
    const firstSearch = fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content;
    expect(JSON.parse(firstSearch)).toMatchObject({ is_error: false, output: { truncated: true } });
    const report = fixture.requests[4]!.messages.find(({ role }) => role === 'tool')!.content;
    expect(report).toContain('首次全局搜索被截断');
    expect(fixture.requests[3]!.messages.some(({ role }) => role === 'tool')).toBe(true);
  });

  it('报告为空时将 Explore 作为普通工具失败返回', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'delegate-empty-report', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查代码', subagent_type: 'Explore' }),
      } }] }
      : index === 2 ? { content: '   ' } : { content: 'Explore 未返回报告。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };

    await runAgent(config, '委派调查', { smokeTool: false });

    expect(fixture.requests).toHaveLength(3);
    const failure = JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(failure).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  });

  it('内部工具调用后仍无报告时将 Explore 作为普通工具失败返回', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-empty-after-tools', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查代码', subagent_type: 'Explore' }),
      } }] };
      if (index === 2) return { calls: [{ id: 'explore-tool-before-empty', type: 'function', function: {
        name: 'glob', arguments: JSON.stringify({ pattern: '*.ts' }),
      } }] };
      if (index === 3) return { content: '   ' };
      return { content: 'Explore 未返回报告。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 5,
    };

    await runAgent(config, '委派调查', { smokeTool: false });

    expect(fixture.requests).toHaveLength(4);
    const failure = JSON.parse(fixture.requests[3]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(failure).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  });

  it('普通 Explore 模型失败作为 agent 工具失败回传', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'delegate-model-failure', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查代码', subagent_type: 'Explore' }),
      } }] }
      : index === 2 ? { status: 500, content: 'Explore provider unavailable' } : { content: '调查暂不可用。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };

    await runAgent(config, '委派调查', { smokeTool: false });

    expect(fixture.requests).toHaveLength(3);
    expect(JSON.parse(fixture.requests[2]!.messages.find(({ role }) => role === 'tool')!.content))
      .toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  });

  it('父轮次取消正在等待模型响应的 Explore，且不再请求后续模型轮次', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'delegate-cancel-explore', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查代码', subagent_type: 'Explore' }),
      } }] }
      : { frames: [{ delta: { content: '缓慢' }, delayMs: 500 }, { delta: {}, finish_reason: 'stop' }] });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 5000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 4,
    };
    const cancellation = new AbortController();
    const run = runAgent(config, '委派调查', { smokeTool: false, signal: cancellation.signal });
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
    cancellation.abort();

    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests).toHaveLength(2);
  });

  it('父轮次超时停止正在执行的 Explore，且不启动后续模型请求', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'delegate-timeout-explore', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查代码', subagent_type: 'Explore' }),
      } }] }
      : { frames: [{ delta: { content: '缓慢' }, delayMs: 500 }, { delta: {}, finish_reason: 'stop' }] });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 200, maxSteps: 4,
    };

    await expect(runAgent(config, '委派调查', { smokeTool: false })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fixture.requests).toHaveLength(2);
  });
});

describe('后台子 Agent 启动', () => {
  let workspace: string;
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('立即返回任务和启动调用 ID，并在主 Agent 继续处理时保留独立任务', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-background-agent-'));
    let finishChild!: () => void;
    const childGate = new Promise<void>((resolve) => { finishChild = resolve; });
    const fixture = await startLocalOpenAIModel(async (request, index) => {
      const userText = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n');
      if (userText.includes('任务：后台子任务')) {
        await childGate;
        return { content: '后台结果已完成。' };
      }
      if (index === 1) return { calls: [{ id: 'launch-background-task', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '后台调查', prompt: '后台子任务', background: true }),
      } }] };
      return { content: '主 Agent 已继续。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 5,
    };
    const backgroundTasks = new BackgroundAgentTasks();

    const result = await runAgent(config, '启动后台子任务后继续', { smokeTool: false, backgroundTasks });

    expect(result.text).toContain('主 Agent 已继续');
    expect(fixture.requests).toHaveLength(3);
    const parentContinuation = fixture.requests.find((request) => request.messages.some(({ role, content }) => role === 'user' && content.includes('启动后台子任务后继续')) && request.messages.some(({ role }) => role === 'tool'));
    expect(parentContinuation).toBeDefined();
    const toolOutput = JSON.stringify(parentContinuation?.messages.find(({ role }) => role === 'tool')?.content);
    expect(toolOutput).toContain('launch-background-task');
    expect(toolOutput).toContain('taskId');
    expect(toolOutput).toContain('避免');
    expect(backgroundTasks.runningCount).toBe(1);
    finishChild();
  });

  it('同一任务池最多运行十个后台任务，完成后可再次启动', async () => {
    const tasks = new BackgroundAgentTasks();
    const completions: Array<() => void> = [];
    for (let index = 0; index < 10; index += 1) {
      tasks.launch(`launch-${index}`, `调查 ${index}`, () => new Promise<string>((resolve) => {
        completions.push(() => resolve(`报告 ${index}`));
      }));
    }

    expect(tasks.runningCount).toBe(10);
    expect(() => tasks.launch('launch-over-limit', '超出上限', async () => '不应启动'))
      .toThrow('后台子 Agent 任务已达上限（10 个）');
    completions[0]!();
    await vi.waitFor(() => expect(tasks.runningCount).toBe(9));
    expect(tasks.launch('launch-after-completion', '完成后的任务', async () => '可再次启动').launchCallId)
      .toBe('launch-after-completion');
  });

  it('CLI 退出时向仍运行的后台任务发送取消信号', async () => {
    const tasks = new BackgroundAgentTasks();
    let wasAborted = false;
    tasks.launch('launch-during-exit', '退出时取消', (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        wasAborted = true;
        reject(signal.reason);
      }, { once: true });
    }));

    tasks.abortAll();

    expect(wasAborted).toBe(true);
    await vi.waitFor(() => expect(tasks.runningCount).toBe(0));
  });

  it('可查询、等待多个终态并从任务池取得最终回复和用量', async () => {
    const tasks = new BackgroundAgentTasks();
    const finishers: Array<() => void> = [];
    const first = tasks.launch('launch-first', '第一项调查', () => new Promise((resolve) => {
      finishers.push(() => resolve({ report: '第一项结果', usage: { inputTokens: 12, outputTokens: 4 } }));
    }));
    const second = tasks.launch('launch-second', '第二项调查', () => new Promise<string>((resolve) => {
      finishers.push(() => resolve('第二项结果'));
    }));

    expect(tasks.get(first.taskId)).toMatchObject({ status: 'running', description: '第一项调查' });
    let settled = false;
    const waiting = tasks.wait([first.taskId, second.taskId]).then((results) => { settled = true; return results; });
    finishers[0]!();
    await vi.waitFor(() => expect(tasks.get(first.taskId)?.status).toBe('succeeded'));
    expect(settled).toBe(false);
    finishers[1]!();

    await expect(waiting).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: first.taskId, status: 'succeeded', result: '第一项结果', usage: { inputTokens: 12, outputTokens: 4 } }),
      expect.objectContaining({ taskId: second.taskId, status: 'succeeded', result: '第二项结果' }),
    ]));
  });

  it('终态先更新后排入含任务信息的会话通知，启动时不通知', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'qhy-background-notification-'));
    try {
      const tasks = new BackgroundAgentTasks(outputDirectory);
      let finish!: (report: string) => void;
      const launched = tasks.launch('launch-notification', '整理调查结果', () => new Promise((resolve) => {
        finish = resolve;
      }));

      expect(tasks.takeNotifications()).toEqual([]);
      finish('完整最终回复');
      let notifications: ReturnType<typeof tasks.takeNotifications> = [];
      await vi.waitFor(() => {
        notifications = tasks.takeNotifications();
        expect(notifications).toHaveLength(1);
      });
      expect(notifications).toEqual([expect.objectContaining({
        taskId: launched.taskId,
        launchCallId: 'launch-notification',
        status: 'succeeded',
        summary: '整理调查结果',
        finalReply: '完整最终回复',
        outputFilePath: join(outputDirectory, `${launched.taskId}.json`),
      })]);
      expect(tasks.get(launched.taskId)?.status).toBe('succeeded');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('失败和取消通知包含原因，查询或等待取得终态后不再通知', async () => {
    const tasks = new BackgroundAgentTasks();
    const failed = tasks.launch('launch-notified-failure', '失败调查', async () => {
      throw Object.assign(new Error('失败原因'), { code: 'PROVIDER_ERROR' });
    });
    let failureNotifications: ReturnType<typeof tasks.takeNotifications> = [];
    await vi.waitFor(() => {
      failureNotifications = tasks.takeNotifications();
      expect(failureNotifications).toHaveLength(1);
    });
    expect(failureNotifications).toEqual([expect.objectContaining({
      taskId: failed.taskId, status: 'failed', reason: expect.any(String),
    })]);

    const queried = tasks.launch('launch-queried', '主动等待', async () => '等待结果');
    await expect(tasks.wait([queried.taskId])).resolves.toMatchObject([{ status: 'succeeded' }]);
    expect(tasks.takeNotifications()).toEqual([]);

    const queriedDirectly = tasks.launch('launch-queried-directly', '主动查询', async () => '查询结果');
    await vi.waitFor(() => expect(tasks.get(queriedDirectly.taskId)?.status).toBe('succeeded'));
    expect(tasks.takeNotifications()).toEqual([]);

    const cancelled = tasks.launch('launch-notified-cancel', '取消调查', (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    tasks.cancel(cancelled.taskId);
    let cancellationNotifications: ReturnType<typeof tasks.takeNotifications> = [];
    await vi.waitFor(() => {
      cancellationNotifications = tasks.takeNotifications();
      expect(cancellationNotifications).toHaveLength(1);
    });
    expect(cancellationNotifications[0]).toMatchObject({
      taskId: cancelled.taskId, status: 'cancelled', reason: expect.any(String),
    });
  });

  it('长回复在通知中明确截断，查询仍返回完整回复', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'qhy-background-truncated-notification-'));
    try {
      const tasks = new BackgroundAgentTasks(outputDirectory, 128);
      const fullReply = '完整内容'.repeat(500);
      const launched = tasks.launch('launch-long-notification', '长报告', async () => fullReply);
      let notifications: ReturnType<typeof tasks.takeNotifications> = [];
      await vi.waitFor(() => {
        notifications = tasks.takeNotifications();
        expect(notifications).toHaveLength(1);
      });
      const [notification] = notifications;
      expect(notification?.finalReply).toContain('[通知中的最终回复已截断');
      expect(notification?.finalReply).not.toContain(fullReply);
      expect(tasks.get(launched.taskId)?.result).toBe(fullReply);
      expect(JSON.parse(await readFile(join(outputDirectory, `${launched.taskId}.json`), 'utf8')))
        .toMatchObject({ finalReply: fullReply });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('取消只报告请求，任务以取消错误终止后才标记取消', async () => {
    const tasks = new BackgroundAgentTasks();
    let observedAbort = false;
    const launched = tasks.launch('launch-cancel', '可取消调查', (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }));

    expect(tasks.cancel(launched.taskId)).toMatchObject({ requested: true, status: 'running' });
    expect(observedAbort).toBe(true);
    await vi.waitFor(() => expect(tasks.get(launched.taskId)?.status).toBe('cancelled'));
    expect(tasks.get(launched.taskId)?.error).toBeDefined();
  });

  it('取消信号未能停止执行时保留其真实成功终态', async () => {
    const tasks = new BackgroundAgentTasks();
    let finish!: (report: string) => void;
    const launched = tasks.launch('launch-late-cancel', '不可即时停止的调查', () => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    expect(tasks.cancel(launched.taskId)).toMatchObject({ requested: true, status: 'running' });
    finish('任务仍完成');
    await expect(tasks.wait([launched.taskId])).resolves.toMatchObject([{ status: 'succeeded', result: '任务仍完成' }]);
    expect(tasks.get(launched.taskId)?.cancellationRequested).toBe(true);
  });

  it('普通执行失败记录失败终态和安全失败原因', async () => {
    const tasks = new BackgroundAgentTasks();
    const launched = tasks.launch('launch-failure', '失败调查', async () => {
      throw Object.assign(new Error('上游请求带敏感内容'), { code: 'PROVIDER_ERROR' });
    });

    await expect(tasks.wait([launched.taskId])).resolves.toMatchObject([{
      status: 'failed', error: '运行失败，请检查配置及模型服务的兼容性。',
    }]);
  });

  it('区分超时终态并将精简结果写入会话任务文件', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'qhy-background-output-'));
    try {
      const tasks = new BackgroundAgentTasks(outputDirectory);
      const success = tasks.launch('launch-success-output', '可取得结果的调查', async () => ({
        report: '最终报告', usage: { inputTokens: 21, outputTokens: 8 },
      }));
      await expect(tasks.wait([success.taskId])).resolves.toMatchObject([{
        status: 'succeeded', result: '最终报告', usage: { inputTokens: 21, outputTokens: 8 },
      }]);
      const successFile = JSON.parse(await readFile(join(outputDirectory, `${success.taskId}.json`), 'utf8'));
      expect(successFile).toMatchObject({
        taskId: success.taskId, description: '可取得结果的调查', status: 'succeeded',
        finalReply: '最终报告', usage: { inputTokens: 21, outputTokens: 8 },
      });
      expect(successFile).not.toHaveProperty('result');
      const launched = tasks.launch('launch-timeout', '超时调查', async () => {
        throw Object.assign(new Error('超时'), { code: 'TIMEOUT' });
      });

      await vi.waitFor(() => expect(tasks.get(launched.taskId)?.status).toBe('timed_out'));
      const task = tasks.get(launched.taskId)!;
      const saved = JSON.parse(await readFile(join(outputDirectory, `${launched.taskId}.json`), 'utf8'));
      expect(task).toMatchObject({ status: 'timed_out', description: '超时调查' });
      expect(saved).toMatchObject({ taskId: launched.taskId, description: '超时调查', status: 'timed_out' });
      expect(saved).not.toHaveProperty('toolCalls');
      expect(saved).not.toHaveProperty('arguments');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
