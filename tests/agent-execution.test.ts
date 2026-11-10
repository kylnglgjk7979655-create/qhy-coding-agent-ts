import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

describe('公共工具执行边界', () => {
  let workspace: string;
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it('执行事件通知失败时只输出诊断，模型仍收到正确工具结果', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    await writeFile(join(workspace, 'note.txt'), '保留的文件内容');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'call_public_read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'call_public_runtime', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
        { id: 'call_public_write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: '写入内容' }) } },
      ] }
      : { content: '读取完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const events: string[] = [];
      const result = await runAgent(config, '读取文件', {
        smokeTool: false,
        onToolEvent: (event) => {
          events.push(`${event.callId}:${event.status}`);
          throw new Error('通知处理器异常');
        },
      });
      const toolMessages = fixture.requests[1]?.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
      expect(toolMessages.map(({ tool_call_id }) => tool_call_id).sort()).toEqual(['call_public_read', 'call_public_runtime', 'call_public_write']);
      expect(JSON.parse(toolMessages.find(({ tool_call_id }) => tool_call_id === 'call_public_read')!.content))
        .toEqual({ is_error: false, output: { content: '保留的文件内容' } });
      expect(JSON.parse(toolMessages.find(({ tool_call_id }) => tool_call_id === 'call_public_runtime')!.content))
        .toEqual(expect.objectContaining({ is_error: false, output: expect.objectContaining({ workspace: config.workspace, probe: expect.any(String) }) }));
      expect(JSON.parse(toolMessages.find(({ tool_call_id }) => tool_call_id === 'call_public_write')!.content))
        .toEqual({ is_error: false, output: { success: true } });
      expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('写入内容');
      expect(result.text).toBe('读取完成。');
      expect(events.sort()).toEqual([
        'call_public_read:started', 'call_public_read:succeeded',
        'call_public_runtime:started', 'call_public_runtime:succeeded',
        'call_public_write:started', 'call_public_write:succeeded',
      ].sort());
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('执行事件通知失败');
    } finally {
      write.mockRestore();
    }
  });

  it('过期读取基线阻止覆盖，重新读取及成功写入后允许后续受控写入', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    await writeFile(join(workspace, 'note.txt'), '初始内容');
    const fixture = await startLocalOpenAIModel(async (_request, index) => {
      if (index === 1) return { calls: [{ id: 'baseline-read', type: 'function', function: {
        name: 'read_file', arguments: '{"path":"note.txt"}',
      } }] };
      if (index === 2) {
        await writeFile(join(workspace, 'note.txt'), '外部修改');
        return { calls: [{ id: 'stale-write', type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: '不应覆盖' }),
        } }] };
      }
      if (index === 3) return { calls: [
        { id: 'refresh-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
        { id: 'refreshed-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: '已更新' }) } },
      ] };
      if (index === 4) return { calls: [
        { id: 'create-file', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: '初次创建' }) } },
        { id: 'overwrite-created', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: '基线已更新' }) } },
      ] };
      return { content: '文件处理完成。' };
    });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 8,
    };

    await runAgent(config, '处理文件', { smokeTool: false });

    const staleResult = fixture.requests.flatMap(({ messages }) => messages)
      .find((message) => message.role === 'tool' && 'tool_call_id' in message && message.tool_call_id === 'stale-write')!.content;
    expect(JSON.parse(staleResult)).toMatchObject({ is_error: true, error: { message: expect.stringContaining('请重新读取') } });
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('已更新');
    expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('基线已更新');
  });

  it('SDK 参数 schema 拒绝通过统一结果和拒绝事件反馈', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'call_bad_args', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt', extra: true }) } }] }
      : { content: '参数已修正。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const events: Array<{ callId: string; toolName: string; status: string; errorCode?: string }> = [];
    await runAgent(config, '读取文件', { smokeTool: false, onToolEvent: (event) => events.push(event) });
    const toolMessage = fixture.requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { content: string; tool_call_id: string };
    expect(toolMessage.tool_call_id).toBe('call_bad_args');
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: true, error: {
      code: 'INVALID_TOOL_ARGUMENTS', message: '工具参数无效，请根据工具参数定义修正后重试。',
    } });
    expect(events).toEqual([{ callId: 'call_bad_args', toolName: 'read_file', status: 'rejected', errorCode: 'INVALID_TOOL_ARGUMENTS' }]);
  });

  it('异步执行事件通知拒绝不阻塞工具结果或后续调用', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    await writeFile(join(workspace, 'note.txt'), '仍可读取');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'async-notify-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'async-notify-runtime', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
      ] }
      : { content: '后续模型请求完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const result = await runAgent(config, '读取并检查运行信息', {
        smokeTool: false,
        onToolEvent: async () => { throw new Error('异步通知拒绝'); },
      });
      const toolMessages = fixture.requests[1]?.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
      expect(toolMessages).toHaveLength(2);
      expect(JSON.parse(toolMessages[0]!.content)).toEqual({ is_error: false, output: { content: '仍可读取' } });
      expect(JSON.parse(toolMessages[1]!.content)).toMatchObject({ is_error: false, output: { workspace: config.workspace } });
      expect(result.text).toBe('后续模型请求完成。');
      expect(fixture.requests).toHaveLength(2);
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('执行事件通知失败');
    } finally {
      write.mockRestore();
    }
  });

  it('同批可并发工具在公共 Agent 执行入口中重叠运行', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    await writeFile(join(workspace, 'note.txt'), '并发读取');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'parallel-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
        { id: 'parallel-runtime', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
      ] }
      : { content: '读取完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    let active = 0;
    let maximumActive = 0;
    await runAgent(config, '并发读取', {
      smokeTool: false,
      onToolCallStart: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
      },
    });
    expect(maximumActive).toBe(2);
    expect(fixture.requests[0]!.messages[0]!.content).toContain('无依赖的工具调用尽量放在同一批');
    expect(fixture.requests).toHaveLength(2);
  });

  it('并发调用最多启动十个，空位释放后继续队首调用', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    const calls = Array.from({ length: 11 }, (_, index) => ({
      id: `limit-${index}`,
      type: 'function' as const,
      function: { name: 'runtimeInfo', arguments: '{}' },
    }));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls }
      : { content: '全部运行完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    let entered = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirstWave!: () => void;
    let tenEntered!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const tenCallsEntered = new Promise<void>((resolve) => { tenEntered = resolve; });
    const run = runAgent(config, '执行 11 次运行信息查询', {
      smokeTool: false,
      onToolCallStart: async () => {
        entered += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (entered === 10) tenEntered();
        await firstWave;
        active -= 1;
      },
    });
    await tenCallsEntered;
    expect(entered).toBe(10);
    releaseFirstWave();
    await run;
    expect(entered).toBe(11);
    expect(maximumActive).toBe(10);
  });

  it('并发人工审批等待期间不消耗整轮执行预算', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    await writeFile(join(workspace, 'note.txt'), '审批后读取');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'approval-read-first', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
        { id: 'approval-read-second', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
      ] }
      : { content: '两项审批均已完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [{ toolName: 'read_file', action: 'ask' }], timeoutMs: 1000, humanTimeoutMs: 500 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 100, maxSteps: 5,
    };
    const result = await runAgent(config, '先完成两项独立审批再读取', {
      smokeTool: false,
      approvalControl: async ({ callId }) => {
        await new Promise((resolve) => setTimeout(resolve, callId === 'approval-read-first' ? 30 : 170));
        return 'approve';
      },
    });
    expect(result.text).toBe('两项审批均已完成。');
    expect(fixture.requests).toHaveLength(2);
  });

  it('独占调用等待此前调用结束并阻止后续调用越过屏障', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'barrier-before-1', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
        { id: 'barrier-before-2', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
        { id: 'barrier-exclusive', type: 'function', function: { name: 'write_file', arguments: '{"path":"barrier.txt","content":"done"}' } },
        { id: 'barrier-after', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
      ] }
      : { content: '屏障完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const waiters = new Map<string, () => void>();
    for (const id of ['barrier-before-1', 'barrier-before-2', 'barrier-exclusive', 'barrier-after']) {
      gates.set(id, () => {});
      waiters.set(id, () => {});
    }
    const holds = new Map<string, Promise<void>>();
    for (const id of gates.keys()) {
      holds.set(id, new Promise<void>((resolve) => gates.set(id, resolve)));
    }
    const entered = new Map<string, Promise<void>>();
    for (const id of waiters.keys()) {
      entered.set(id, new Promise<void>((resolve) => waiters.set(id, resolve)));
    }
    const result = runAgent(config, '顺序执行并发屏障', {
      smokeTool: false,
      onToolCallStart: async ({ callId }) => {
        started.push(callId);
        waiters.get(callId)?.();
        await holds.get(callId);
      },
    });
    await Promise.all([entered.get('barrier-before-1'), entered.get('barrier-before-2')]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(started).toEqual(['barrier-before-1', 'barrier-before-2']);
    gates.get('barrier-before-1')?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(started).toEqual(['barrier-before-1', 'barrier-before-2']);
    gates.get('barrier-before-2')?.();
    await entered.get('barrier-exclusive');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(started).toEqual(['barrier-before-1', 'barrier-before-2', 'barrier-exclusive']);
    gates.get('barrier-exclusive')?.();
    await entered.get('barrier-after');
    expect(started).toEqual(['barrier-before-1', 'barrier-before-2', 'barrier-exclusive', 'barrier-after']);
    gates.get('barrier-after')?.();
    await result;
    expect(await readFile(join(workspace, 'barrier.txt'), 'utf8')).toBe('done');
  });

  it('首个排队工具开始后取消，不启动同批后续工具或下一次模型请求', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'cancel-first-runtime', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
        { id: 'cancel-second-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'must-not-exist.txt', content: '不可写入' }) } },
      ] }
      : { content: '不应收到的回答。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const cancellation = new AbortController();
    await expect(runAgent(config, '运行后取消', {
      smokeTool: false,
      onToolEvent: (event) => {
        if (event.callId === 'cancel-first-runtime' && event.status === 'started') cancellation.abort();
      },
      signal: cancellation.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'must-not-exist.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['sync', 'async'] as const)('人工审批的拒绝与批准不受 %s 观察回调故障影响', async (notification) => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-human-notify-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'deny', type: 'function', function: { name: 'write_file', arguments: '{"path":"denied.txt","content":"拒绝内容"}' } },
      { id: 'allow', type: 'function', function: { name: 'write_file', arguments: '{"path":"allowed.txt","content":"批准内容"}' } },
    ] } : { content: '人工决定已处理' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000, humanTimeoutMs: 500 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const result = await runAgent(config, '人工决定', {
        smokeTool: false,
        approvalControl: async (call) => call.callId === 'deny' ? 'deny' : 'approve',
        onToolEvent: notification === 'sync'
          ? () => { throw new Error('通知中的私有异常'); }
          : async () => { throw new Error('通知中的私有异常'); },
      });
      expect(result.text).toBe('人工决定已处理');
      expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('批准内容');
      await expect(readFile(join(workspace, 'denied.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const messages = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool');
      expect(messages.map(({ content }) => JSON.parse(content).is_error)).toEqual([true, false]);
      expect(fixture.approvalRequests).toHaveLength(0);
      const output = diagnostic.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('执行事件通知失败');
      expect(output).not.toContain('通知中的私有异常');
    } finally { diagnostic.mockRestore(); }
  });

});
