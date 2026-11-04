import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent.js';
import type { ResolvedConfig } from '../src/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

describe('工具批次顺序与新增往返配对', () => {
  let workspace = '';
  let closeFixture: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0]) {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-agent-pairing-'));
    const fixture = await startLocalOpenAIModel(respond);
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    return { fixture, config };
  }

  it('按批次顺序完成写入后读取，并按不同调用 ID 返回各自结果', async () => {
    const { fixture, config } = await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'write-first', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: '新内容' }) } },
        { id: 'read-second', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
      ] }
      : { content: '读取完成。' });
    await runAgent(config, '先写后读', { smokeTool: false });
    const tools = fixture.requests[1]!.messages.filter((message) => message.role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
    expect(tools.map((message) => message.tool_call_id)).toEqual(['write-first', 'read-second']);
    expect(JSON.parse(tools[1]!.content)).toEqual({ is_error: false, output: { content: '新内容' } });
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('新内容');
  });

  it('普通写入失败后继续执行读取，并按 ID 返回旧文件内容', async () => {
    const { fixture, config } = await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'write-fails', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'missing/note.txt', content: '新内容' }) } },
        { id: 'read-old', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
      ] }
      : { content: '失败后仍继续。' });
    await writeFile(join(workspace, 'note.txt'), '旧内容');
    await runAgent(config, '写入失败后读取', { smokeTool: false });
    const tools = fixture.requests[1]!.messages.filter((message) => message.role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
    expect(JSON.parse(tools[0]!.content)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(tools[1]!.tool_call_id).toBe('read-old');
    expect(JSON.parse(tools[1]!.content)).toEqual({ is_error: false, output: { content: '旧内容' } });
  });

  it.each([
    ['missing', [{ type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } }]],
    ['empty', [{ id: '', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } }]],
    ['duplicate', [
      { id: 'same-id', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } },
      { id: 'same-id', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'also-blocked.txt', content: 'y' }) } },
    ]],
  ])('原始调用 ID %s 时，在任何副作用和后续模型请求前拒绝', async (_kind, calls) => {
    const { fixture, config } = await setup((_request, index) => index === 1
      ? { calls }
      : { content: '不应请求' });
    await expect(runAgent(config, '执行写入', { smokeTool: false })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace, 'also-blocked.txt'), 'utf8')).rejects.toThrow();
  });

  it('跨 SSE 分片累积调用 ID，接受参数续片并在重复 ID 时先于执行拒绝', async () => {
    const { fixture, config } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'fragmented-same', type: 'function', function: { name: 'write_file', arguments: '' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'first.txt', content: 'x' }) } }] } },
        { delta: { tool_calls: [{ index: 1, id: 'fragmented-same', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'second.txt', content: 'y' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '不应请求' });
    await expect(runAgent(config, '执行写入', { smokeTool: false })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace, 'second.txt'), 'utf8')).rejects.toThrow();
  });

  it('finish_reason 为 stop 且含完整工具批次时仍校验并执行工具调用', async () => {
    const { fixture, config } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'stop-finish-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'stop.txt', content: '已执行' }) } }] } },
        { delta: {}, finish_reason: 'stop' },
      ] }
      : { content: '完成。' });
    await runAgent(config, '写入文件', { smokeTool: false });
    expect(await readFile(join(workspace, 'stop.txt'), 'utf8')).toBe('已执行');
    expect(fixture.requests).toHaveLength(2);
  });
});
