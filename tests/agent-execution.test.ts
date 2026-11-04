import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent.js';
import type { ResolvedConfig } from '../src/config.js';
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

  it('SDK 参数 schema 拒绝通过统一结果和拒绝事件反馈', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-tools-'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'call_bad_args', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt', extra: true }) } }] }
      : { content: '参数已修正。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
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
});
