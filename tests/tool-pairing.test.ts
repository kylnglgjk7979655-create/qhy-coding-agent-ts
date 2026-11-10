import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const cli = resolve('dist/cli.js');

describe('工具批次顺序与新增往返配对', () => {
  let workspace = '';
  let closeFixture: (() => Promise<void>) | undefined;
  let requests: Awaited<ReturnType<typeof startLocalOpenAIModel>>['requests'] | undefined;
  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    requests = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0]) {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-cli-pairing-'));
    const fixture = await startLocalOpenAIModel(respond);
    closeFixture = fixture.close;
    requests = fixture.requests;
    await mkdir(join(workspace, '.agent'), { recursive: true });
    await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'PAIRING_KEY', baseURL: fixture.baseURL,
      timeoutMs: 5000, maxSteps: 5, approval: { mode: 'auto' },
    }));
    return fixture;
  }

  function run(input = '继续处理\n/exit\n', onStdout?: (stdout: string) => void) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [cli], {
        cwd: workspace, env: { ...process.env, HOME: workspace, USERPROFILE: workspace, PAIRING_KEY: 'pairing-fixture-key' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 9000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onStdout?.(stdout); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('exit', (code) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
      child.stdin.end(input);
    });
  }

  function toolMessages(index = 1) {
    return requests![index]!.messages.filter((message) => message.role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
  }

  it('按批次顺序完成写入后读取，并按调用 ID 返回结果', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'write-first', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: '新内容' }) } },
        { id: 'read-second', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
      ] }
      : { content: '读取完成。' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    const tools = toolMessages();
    expect(tools.map(({ tool_call_id }) => tool_call_id)).toEqual(['write-first', 'read-second']);
    expect(JSON.parse(tools[1]!.content)).toEqual({ is_error: false, output: { content: '新内容' } });
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('新内容');
  });

  it('普通写入失败后继续读取旧内容', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'write-fails', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'missing/note.txt', content: '新内容' }) } },
        { id: 'read-old', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
      ] }
      : { content: '失败后仍继续。' });
    await writeFile(join(workspace, 'note.txt'), '旧内容');
    const result = await run();
    expect(result.code).toBe(0);
    const tools = toolMessages();
    expect(JSON.parse(tools[0]!.content)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(tools[1]!.tool_call_id).toBe('read-old');
    expect(JSON.parse(tools[1]!.content)).toEqual({ is_error: false, output: { content: '旧内容' } });
  });

  it('同批拒绝无效参数和未知工具后，仍依次写入、读取并获取运行信息', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'invalid-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: '不可写入', extra: true }) } },
        { id: 'unknown-call', type: 'function', function: { name: 'missing_tool', arguments: '{}' } },
        { id: 'valid-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: '后续新内容' }) } },
        { id: 'valid-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'valid-runtime', type: 'function', function: { name: 'runtimeInfo', arguments: '{"ignored":true}' } },
      ] }
      : { content: '拒绝后其余操作完成。' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    const tools = toolMessages();
    expect(tools.map(({ tool_call_id }) => tool_call_id)).toEqual([
      'invalid-write', 'unknown-call', 'valid-write', 'valid-read', 'valid-runtime',
    ]);
    expect(tools.map(({ content }) => JSON.parse(content))).toEqual([
      { is_error: true, error: { code: 'INVALID_TOOL_ARGUMENTS', message: '工具参数无效，请根据工具参数定义修正后重试。' } },
      { is_error: true, error: { code: 'UNKNOWN_TOOL', message: '不存在名为 missing_tool 的工具。' } },
      { is_error: false, output: { success: true } },
      { is_error: false, output: { content: '后续新内容' } },
      { is_error: false, output: { workspace: expect.any(String), probe: expect.any(String) } },
    ]);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('后续新内容');
    const events = result.stdout.split('\n').filter((line) => line.startsWith('[工具]'));
    expect(events.slice(0, 4)).toEqual([
      '[工具] write_file：拒绝', '[工具] missing_tool：拒绝',
      '[工具] write_file：开始', '[工具] write_file：成功',
    ]);
    expect(events.slice(4).sort()).toEqual([
      '[工具] read_file：开始', '[工具] read_file：成功',
      '[工具] runtimeInfo：开始', '[工具] runtimeInfo：成功',
    ].sort());
  });

  it('失败写入后读取同一缺失路径也失败，并返回两项结果', async () => {
    await setup((_request, index) => index === 1
      ? { calls: [
        { id: 'write-missing-parent', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'missing/note.txt', content: '内容' }) } },
        { id: 'read-uncreated', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing/note.txt' }) } },
      ] }
      : { content: '已检查。' });
    const result = await run();
    expect(result.code).toBe(0);
    const tools = toolMessages();
    expect(tools.map(({ tool_call_id }) => tool_call_id)).toEqual(['write-missing-parent', 'read-uncreated']);
    expect(JSON.parse(tools[0]!.content)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(JSON.parse(tools[1]!.content)).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['missing', [{ type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } }]],
    ['empty', [{ id: '', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } }]],
    ['duplicate', [
      { id: 'same-id', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } },
      { id: 'same-id', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'also-blocked.txt', content: 'y' }) } },
    ]],
  ])('原始调用 ID %s 时，在副作用和后续模型请求前拒绝', async (_kind, calls) => {
    await setup((_request, index) => index === 1 ? { calls } : { content: '不应请求' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('错误：');
    expect(requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'blocked.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace, 'also-blocked.txt'), 'utf8')).rejects.toThrow();
  });

  it('跨 SSE 分片累积 ID 和参数，并成功执行同名的不同调用', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'fragment-write-1', type: 'function', function: { name: 'write_file', arguments: '' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'first.txt', content: '首份内容' }) } }] } },
        { delta: { tool_calls: [{ index: 1, id: 'fragment-write-2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'second.txt', content: '第二份内容' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '写入完成。' });
    const result = await run();
    expect(result.code).toBe(0);
    const tools = toolMessages();
    expect(tools.map(({ tool_call_id }) => tool_call_id)).toEqual(['fragment-write-1', 'fragment-write-2']);
    expect(tools.map(({ content }) => JSON.parse(content))).toEqual([
      { is_error: false, output: { success: true } },
      { is_error: false, output: { success: true } },
    ]);
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('首份内容');
    expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('第二份内容');
  });

  it('跨 SSE 分片出现重复 ID 时，在任何副作用和后续请求前拒绝', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'fragmented-same', type: 'function', function: { name: 'write_file', arguments: '' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'first.txt', content: 'x' }) } }] } },
        { delta: { tool_calls: [{ index: 1, id: 'fragmented-same', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'second.txt', content: 'y' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '不应请求' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('错误：');
    expect(requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace, 'second.txt'), 'utf8')).rejects.toThrow();
  });

  it('工具调用首次出现时缺少原始 ID，即使后续补帧也在副作用前拒绝', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'write_file', arguments: '' } }] } },
        { delta: { tool_calls: [{ index: 0, id: 'late-real-id', function: { arguments: JSON.stringify({ path: 'first.txt', content: '不应写入' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '不应请求' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('错误：');
    expect(requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toThrow();
  });

  it('接受同索引和同 ID 的重复元数据参数续片', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'normal-repeat', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] } },
        { delta: { tool_calls: [{ index: 0, id: 'normal-repeat', type: 'function', function: { arguments: '"first.txt","content":"ok"}' } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '写入完成。' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    const tools = toolMessages();
    expect(tools.map(({ tool_call_id }) => tool_call_id)).toEqual(['normal-repeat']);
    expect(JSON.parse(tools[0]!.content)).toEqual({ is_error: false, output: { success: true } });
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('ok');
  });

  it('同一 SSE 批次重复使用工具索引和原始 ID 时拒绝两次写入', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'repeat-id', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'first.txt', content: '不应写入一' }) } }] } },
        { delta: { tool_calls: [{ index: 0, id: 'repeat-id', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'second.txt', content: '不应写入二' }) } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '不应请求' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('错误：');
    expect(requests).toHaveLength(1);
    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(workspace, 'second.txt'), 'utf8')).rejects.toThrow();
  });

  it('finish_reason 为 stop 且含完整工具批次时仍执行工具调用', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'stop-finish-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'stop.txt', content: '已执行' }) } }] } },
        { delta: {}, finish_reason: 'stop' },
      ] }
      : { content: '完成。' });
    const result = await run();
    expect(result.code).toBe(0);
    expect(await readFile(join(workspace, 'stop.txt'), 'utf8')).toBe('已执行');
    expect(requests).toHaveLength(2);
  });

  it('模型文本流先输出内容时，不等待响应结束再显示', async () => {
    await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '实时前缀' } },
        { delta: { content: '后续内容' }, finish_reason: 'stop' },
      ], endDelayMs: 1200 }
      : { content: '后续请求。' });
    let sawPrefix!: () => void;
    const prefix = new Promise<void>((resolve) => { sawPrefix = resolve; });
    const resultPromise = run('测试流式输出\n/exit\n', (stdout) => {
      if (stdout.includes('实时前缀')) sawPrefix();
    });
    const arrivedEarly = await Promise.race([
      prefix.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(arrivedEarly).toBe(true);
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('实时前缀后续内容');
  });
});
