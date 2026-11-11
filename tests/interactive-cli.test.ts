import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ function: { name: string } }>;
}

const cli = resolve('dist/cli.js');
const secret = 'interactive-test-secret';

function response(content: string | null, call?: { name: string; id?: string; arguments?: Record<string, unknown>; argumentsJson?: string }, finishReason?: string) {
  return {
    id: 'chatcmpl-test', model: 'test-model', created: 1,
    choices: [{ index: 0, finish_reason: finishReason ?? (call ? 'tool_calls' : 'stop'), message: {
      role: 'assistant', content,
      ...(call ? { tool_calls: [{ id: call.id ?? `call_${call.name}`, type: 'function', function: { name: call.name, arguments: call.argumentsJson ?? JSON.stringify(call.arguments ?? {}) } }] } : {}),
    } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('interactive compiled CLI', () => {
  let cwd: string;
  let server: Server;
  let requests: ChatRequest[];
  let reply: (request: ChatRequest, index: number) => { status?: number; body: unknown } | undefined;
  let onRequest: () => void = () => undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'qhy-interactive-'));
    requests = [];
    reply = () => ({ body: response('回答完成。') });
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
        requests.push(body);
        onRequest();
        const result = reply(body, requests.length);
        if (result === undefined) return;
        if (result.status !== undefined && result.status !== 200) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.body));
          return;
        }
        const customFrames = (result.body as { frames?: Array<{ delta: Record<string, unknown>; finish_reason?: string | null }> }).frames;
        if (customFrames) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const frame of customFrames) {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, ...frame }] })}\n\n`);
          }
          res.end('data: [DONE]\n\n');
          return;
        }
        const completion = result.body as { choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }> };
        const choice = completion.choices[0];
        if (!choice) throw new Error('Missing fixture choice');
        const delta = choice.message.tool_calls
          ? { tool_calls: choice.message.tool_calls.map((toolCall, index) => ({ index, ...toolCall })) }
          : { content: choice.message.content };
        const firstChunk = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] };
        const lastChunk = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(firstChunk)}\n\ndata: ${JSON.stringify(lastChunk)}\n\ndata: [DONE]\n\n`);
      })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'test-model', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${address.port}/v1`,
      workspace: '.', timeoutMs: 3000, maxSteps: 20,
      approval: { rules: [{ toolName: 'write_file', action: 'allow' }] },
    }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(cwd, { recursive: true, force: true });
  });

  function run(input: string, args: string[] = []) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_MODEL_API_KEY: secret }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('exit', (code) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
      child.stdin.end(input);
    });
  }

  function logs(stderr: string) {
    return stderr.trim().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('documents both commands that start a new conversation', async () => {
    const result = await run('', ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('/new');
    expect(result.stdout).toContain('/clear');
  });

  it('accepts multiple ordered turns until /exit and persists their full exchange', async () => {
    reply = (_request, index) => ({ body: response(`第${index}轮回答。`) });
    const result = await run('第一条\n第二条\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('第1轮回答。');
    expect(result.stdout).toContain('第2轮回答。');
    expect(requests).toHaveLength(2);
    const started = logs(result.stderr).find((event) => event.event === 'run.started');
    const finished = logs(result.stderr).find((event) => event.event === 'run.finished');
    expect(started?.conversationId).toEqual(expect.any(String));
    expect(finished?.runId).toBe(started?.runId);
    const directory = join(cwd, '.agent', 'conversations');
    const filename = `${started?.conversationId}.json`;
    const history = JSON.parse(await readFile(join(directory, filename), 'utf8')) as Array<{ role: string }>;
    expect(history.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history).toEqual([
      { role: 'user', content: '第一条' },
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: '第1轮回答。' }] }),
      { role: 'user', content: '第二条' },
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: '第2轮回答。' }] }),
    ]);
    expect(requests[1]?.messages.filter(({ role }) => role !== 'system')).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第1轮回答。' },
      { role: 'user', content: '第二条' },
    ]);
    expect(await readdir(directory)).toEqual([filename]);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o600);
    }

    const resumed = await run('第三条\n/exit\n', ['--conversation-id', String(started?.conversationId)]);
    expect(resumed.code).toBe(0);
    expect(requests[2]?.messages.filter(({ role }) => role !== 'system')).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第1轮回答。' },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: '第2轮回答。' },
      { role: 'user', content: '第三条' },
    ]);
    const resumedHistory = JSON.parse(await readFile(join(directory, filename), 'utf8')) as unknown[];
    expect(resumedHistory).toEqual([
      ...history,
      { role: 'user', content: '第三条' },
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: '第3轮回答。' }] }),
    ]);
  });

  it('resumes a conversation by ID', async () => {
    const id = 'resume-test';
    await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'conversations', `${id}.json`), JSON.stringify([
      { role: 'user', content: '以前说过的事' }, { role: 'assistant', content: '旧回答' },
    ]));
    const result = await run('继续\n/exit\n', ['--conversation-id', id]);
    expect(result.code).toBe(0);
    expect(requests[0]?.messages.some(({ content }) => content.includes('旧回答'))).toBe(true);
  });

  it.each(['http-error', 'incomplete'] as const)('保留成功历史，%s 轮次不保存且不进入下一轮输入', async (failure) => {
    const id = 'failure-recovery';
    const args = ['--conversation-id', id];
    expect((await run('成功轮次\n/exit\n', args)).code).toBe(0);
    const path = join(cwd, '.agent', 'conversations', `${id}.json`);
    const previous = await readFile(path, 'utf8');
    reply = (_request, index) => index === 2 || index === 3
      ? failure === 'http-error'
        ? { status: 500, body: { error: { message: 'fixture failure' } } }
        : { body: response('尚未完成的回答', undefined, 'length') }
      : { body: response('恢复成功。') };
    const failed = await run('失败轮次\n/exit\n', args);
    expect(failed.code).toBe(0);
    expect(failed.stderr).toContain('PROVIDER_ERROR');
    expect(await readFile(path, 'utf8')).toBe(previous);

    const result = await run('失败轮次\n恢复轮次\n/exit\n', args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('恢复成功。');
    const history = JSON.parse(await readFile(path, 'utf8')) as unknown[];
    expect(history).toEqual([
      ...JSON.parse(previous) as unknown[],
      { role: 'user', content: '恢复轮次' },
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: '恢复成功。' }] }),
    ]);
    expect(requests[3]?.messages.filter(({ role }) => role !== 'system')).toEqual([
      { role: 'user', content: '成功轮次' },
      { role: 'assistant', content: '回答完成。' },
      { role: 'user', content: '恢复轮次' },
    ]);
    expect(result.stderr).toContain('PROVIDER_ERROR');
  });

  it.each([401, 403])('preserves authentication error classification for HTTP %s and continues input', async (status) => {
    reply = (_request, index) => index === 1
      ? { status, body: { error: { message: 'fixture auth failure' } } }
      : { body: response('鉴权失败后恢复。') };
    const result = await run('鉴权失败轮\n恢复输入\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('AUTH_ERROR');
    expect(result.stdout).toContain('鉴权失败后恢复。');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some(({ role, content }) => role === 'user' && content === '鉴权失败轮')).toBe(false);
  });

  it('keeps a successful file side effect when the following model request fails, without saving that turn', async () => {
    reply = (_request, index) => {
      if (index === 1) return { body: response(null, { name: 'write_file', arguments: { path: 'kept.txt', content: '写入已生效' } }) };
      if (index === 2) return { status: 500, body: { error: { message: 'fixture failure after tool' } } };
      return { body: response('恢复轮次完成。') };
    };
    const result = await run('失败轮的用户消息\n恢复轮次\n/exit\n');
    expect(result.code).toBe(0);
    expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('写入已生效');
    expect(result.stdout).toContain('恢复轮次完成。');
    expect(requests).toHaveLength(3);
    const started = logs(result.stderr).find((event) => event.event === 'run.started');
    const history = JSON.parse(await readFile(join(cwd, '.agent', 'conversations', `${started?.conversationId}.json`), 'utf8')) as Array<{ role: string; content?: string }>;
    expect(history.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(['恢复轮次']);
    expect(requests[2]?.messages.some(({ role, content }) => role === 'user' && content === '失败轮的用户消息')).toBe(false);
    expect(requests[2]?.messages.some(({ role }) => role === 'tool')).toBe(false);
  });

  it('reads and writes workspace files through a tool round trip, displaying names only', async () => {
    await writeFile(join(cwd, 'note.txt'), 'before');
    reply = (_request, index) => {
      if (index === 1) return { body: response(null, { name: 'read_file', arguments: { path: join(cwd, 'note.txt') } }) };
      if (index === 2) return { body: response(null, { name: 'write_file', arguments: { path: 'note.txt', content: 'after' } }) };
      return { body: response('已完成修改。') };
    };
    const result = await run('请修改 note.txt\n/exit\n');
    expect(result.code).toBe(0);
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after');
    expect(JSON.stringify(requests[1])).toContain('before');
    expect(JSON.stringify(requests[2])).toContain('after');
    expect(result.stdout).toContain('read_file');
    expect(result.stdout).toContain('write_file');
    expect(result.stdout).not.toContain('before');
    expect(result.stdout).not.toContain('after');
    expect(result.stdout).toContain('已完成修改。');
  });

  it('returns a unified success envelope in the tool message with its call ID', async () => {
    await writeFile(join(cwd, 'envelope.txt'), 'known-content');
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'read_file', arguments: { path: 'envelope.txt' } }) }
      : { body: response('读取完成。') };
    const result = await run('读取文件\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { tool_call_id: string; content: string };
    expect(toolMessage.tool_call_id).toBe('call_read_file');
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: false, output: { content: 'known-content' } });
  });

  it('returns a unified execution failure envelope with the original call ID', async () => {
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'read_file', arguments: { path: 'missing.txt' } }) }
      : { body: response('已知文件不存在。') };
    const result = await run('读取缺失文件\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { tool_call_id: string; content: string };
    expect(toolMessage.tool_call_id).toBe('call_read_file');
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: true, error: {
      code: 'TOOL_EXECUTION_ERROR', message: '无法访问文件：目标必须存在且位于工作区内。',
    } });
  });

  it('stops before executing a valid tool when a later model stream chunk is malformed', async () => {
    reply = (_request, index) => index === 1
      ? { body: { frames: [
        { delta: { tool_calls: [{ index: 0, id: 'valid-before-error', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'first.txt', content: '不可写入' }) } }] } },
        { delta: { content: 123 } },
        { delta: {}, finish_reason: 'tool_calls' },
      ] } }
      : { body: response('不应收到的回答。') };
    const result = await run('写文件后遇到流错误\n恢复轮次\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('PROVIDER_ERROR');
    expect(result.stderr).not.toContain('INVALID_TOOL_ARGUMENTS');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some(({ role, content }) => role === 'user' && content === '写文件后遇到流错误')).toBe(false);
    await expect(readFile(join(cwd, 'first.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const started = logs(result.stderr).find((event) => event.event === 'run.started');
    const history = JSON.parse(await readFile(join(cwd, '.agent', 'conversations', `${started?.conversationId}.json`), 'utf8')) as Array<{ role: string; content?: string }>;
    expect(history.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(['恢复轮次']);
  });

  it('returns schema rejection as a unified result without touching the file', async () => {
    await writeFile(join(cwd, 'guarded.txt'), 'unchanged');
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'write_file', arguments: { path: 'guarded.txt', content: 'changed', extra: true } }) }
      : { body: response('参数错误已修正。') };
    const result = await run('写入文件\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { tool_call_id: string; content: string };
    expect(toolMessage.tool_call_id).toBe('call_write_file');
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: true, error: {
      code: 'INVALID_TOOL_ARGUMENTS', message: '工具参数无效，请根据工具参数定义修正后重试。',
    } });
    expect(await readFile(join(cwd, 'guarded.txt'), 'utf8')).toBe('unchanged');
  });

  it.each([
    ['read_file', '{}'],
    ['read_file', '{"path":3}'],
    ['read_file', '{"path":""}'],
    ['read_file', '{invalid'],
    ['write_file', '{"content":"x"}'],
    ['write_file', '{"path":"note.txt"}'],
    ['write_file', '{"path":3,"content":"x"}'],
    ['write_file', '{"path":"note.txt","content":3}'],
    ['write_file', '{"path":"","content":"x"}'],
    ['write_file', '{invalid'],
  ])('compiled CLI rejects %s invalid arguments %s without file changes', async (toolName, rawArguments) => {
    await writeFile(join(cwd, 'note.txt'), '原文件');
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: toolName, id: `invalid-${toolName}`, argumentsJson: rawArguments }) }
      : { body: response('已收到参数错误。') };
    const result = await run('调用文件工具\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { content: string; tool_call_id: string };
    expect(toolMessage.tool_call_id).toBe(`invalid-${toolName}`);
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: true, error: {
      code: 'INVALID_TOOL_ARGUMENTS', message: '工具参数无效，请根据工具参数定义修正后重试。',
    } });
    expect(requests).toHaveLength(2);
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('原文件');
    expect(await readFile(join(cwd, '.agent', 'conversations', `${logs(result.stderr).find((event) => event.event === 'run.started')?.conversationId}.json`), 'utf8')).toContain('已收到参数错误。');
  });

  it('compiled CLI keeps runtimeInfo compatible with extra object fields', async () => {
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'runtimeInfo', arguments: { ignored: 'still accepted' } }) }
      : { body: response('运行信息收到。') };
    const result = await run('检查运行信息\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { content: string };
    const decoded = JSON.parse(toolMessage.content) as { is_error: boolean; output: Record<string, unknown> };
    expect(decoded.is_error).toBe(false);
    expect(Object.keys(decoded.output).sort()).toEqual(['probe', 'workspace']);
    expect(decoded.output.workspace).toBe(await realpath(cwd));
  });

  it('returns an unknown tool as a unified rejection result', async () => {
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'missing_tool', arguments: {} }) }
      : { body: response('工具不存在。') };
    const result = await run('试用未知工具\n/exit\n');
    expect(result.code).toBe(0);
    const toolMessage = requests[1]?.messages.find(({ role }) => role === 'tool') as unknown as { tool_call_id: string; content: string };
    expect(toolMessage.tool_call_id).toBe('call_missing_tool');
    expect(JSON.parse(toolMessage.content)).toEqual({ is_error: true, error: {
      code: 'UNKNOWN_TOOL', message: '不存在名为 missing_tool 的工具。',
    } });
  });

  it('returns a workspace boundary error to the model without revealing file contents', async () => {
    await writeFile(join(cwd, 'outside.txt'), 'private-outside-content');
    await mkdir(join(cwd, 'workspace'));
    await symlink(join(cwd, 'outside.txt'), join(cwd, 'workspace', 'escape.txt'));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'test-model', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${address.port}/v1`,
      workspace: 'workspace', timeoutMs: 3000, maxSteps: 20,
      approval: { rules: [{ toolName: 'write_file', action: 'allow' }] },
    }));
    reply = (_request, index) => {
      if (index === 1) return { body: response(null, { name: 'read_file', arguments: { path: '../outside.txt' } }) };
      if (index === 2) return { body: response(null, { name: 'read_file', arguments: { path: 'escape.txt' } }) };
      if (index === 3) return { body: response(null, { name: 'write_file', arguments: { path: 'escape.txt', content: 'overwritten' } }) };
      return { body: response('该路径超出工作区。') };
    };
    const result = await run('读取文件\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('private-outside-content');
    expect(await readFile(join(cwd, 'outside.txt'), 'utf8')).toBe('private-outside-content');
  });

  it('reports a missing write parent to the model without creating the directory', async () => {
    reply = (request, index) => {
      if (index === 1) return { body: response(null, { name: 'write_file', arguments: { path: 'missing/note.txt', content: 'written' } }) };
      expect(request.messages.some(({ content }) => content.includes('父目录必须存在'))).toBe(true);
      return { body: response('父目录不存在，写入失败。') };
    };
    const result = await run('写入缺失目录中的文件\n/exit\n');
    expect(result.code).toBe(0);
    await expect(readFile(join(cwd, 'missing', 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.stdout).not.toContain('written');
  });

  it('smoke mode forces read_file and verifies the probe in the final answer', async () => {
    reply = (request, index) => {
      if (index === 1) {
        const prompt = request.messages.find(({ role }) => role === 'user')?.content ?? '';
        const path = prompt.match(/读取 (\.agent-smoke-[a-f0-9-]+\.txt)/)?.[1];
        if (!path) throw new Error('Smoke probe path was not provided');
        return { body: response(null, { name: 'read_file', arguments: { path } }) };
      }
      const toolResult = request.messages.find(({ role }) => role === 'tool');
      return { body: response(toolResult?.content ?? '') };
    };
    const result = await run('', ['--smoke-tool']);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('agent-smoke');
    expect(result.stderr).toContain('"toolSmokePassed":true');
  });

  it('continues to another message after the configured step limit fails a turn', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'test-model', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      workspace: '.', timeoutMs: 3000, maxSteps: 1,
    }));
    reply = (_request, index) => index === 1
      ? { body: response(null, { name: 'runtimeInfo' }) }
      : { body: response('下一轮完成。') };
    const result = await run('超限轮次\n下一轮\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('STEP_LIMIT');
    expect(result.stdout).toContain('下一轮完成。');
    expect(requests).toHaveLength(2);
  });

  it('reports step exhaustion when stop includes tool calls and preserves recovery', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'test-model', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      workspace: '.', timeoutMs: 3000, maxSteps: 1,
    }));
    reply = (_request, index) => index === 1
      ? { body: response('工具前置说明。', { name: 'runtimeInfo' }, 'stop') }
      : { body: response('下一轮完成。') };
    const result = await run('超限轮次\n下一轮\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('STEP_LIMIT');
    expect(result.stdout).toContain('下一轮完成。');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some(({ role, content }) => role === 'user' && content === '超限轮次')).toBe(false);
    const started = logs(result.stderr).find((event) => event.event === 'run.started');
    const history = JSON.parse(await readFile(join(cwd, '.agent', 'conversations', `${started?.conversationId}.json`), 'utf8')) as Array<{ role: string; content?: string }>;
    expect(history.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(['下一轮']);
  });

  it.skipIf(process.platform === 'win32').each([false, true])('真实终端 Ctrl+C 停止当前轮次并正常退出空闲终端（请求进行中：%s）', async (requestInProgress) => {
    const historyPath = join(cwd, '.agent', 'conversations', 'terminal-cancel.json');
    expect((await run('已完成的轮次\n/exit\n', ['--conversation-id', 'terminal-cancel'])).code).toBe(0);
    const previous = await readFile(historyPath, 'utf8');
    reply = () => undefined;
    const requestStarted = new Promise<void>((done) => { onRequest = done; });
    const command = [process.execPath, cli, '--conversation-id', 'terminal-cancel'];
    const args = process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-q', '-e', '-c', command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' '), '/dev/null'];
    // macOS script 不接受 Node 的 socket 类型 stdin，cat 将其转换为普通管道。
    const child = spawn('/bin/sh', ['-c', 'cat | script "$@"', 'terminal-test', ...args], {
      cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_MODEL_API_KEY: secret }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let ready: () => void;
    const terminalReady = new Promise<void>((done) => { ready = done; });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes('> ')) ready();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const exited = new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      await Promise.race([
        terminalReady,
        exited.then((code) => { throw new Error(`终端在就绪前退出：${code}\n${output}`); }),
      ]);
      if (requestInProgress) {
        child.stdin.write('取消当前轮次\n');
        await requestStarted;
      }
      child.stdin.end('\x03');
      expect(await exited).toBe(0);
      if (requestInProgress) expect(output).toContain('Interrupt by user');
      expect(requests).toHaveLength(requestInProgress ? 2 : 1);
      expect(await readFile(historyPath, 'utf8')).toBe(previous);
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGKILL');
    }
  });

  it('keeps total request timeout and SIGINT cancellation behavior', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'test-model', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      workspace: '.', timeoutMs: 120, maxSteps: 20,
    }));
    reply = (_request, index) => index === 1 ? undefined : { body: response('超时后仍可继续。') };
    const result = await run('请求超时\n超时后的下一轮\n/exit\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('TIMEOUT');
    expect(result.stdout).toContain('超时后仍可继续。');
    expect(requests).toHaveLength(2);

    const requestStarted = new Promise<void>((done) => { onRequest = done; });
    const child = spawn(process.execPath, [cli], {
      cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_MODEL_API_KEY: secret }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((done) => child.once('close', done));
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.write('cancel this request\n');
    await requestStarted;
    child.kill('SIGINT');
    child.stdin.write('continue after interrupt\n');
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`下一轮未完成：${stdout}\n${stderr}`)), 3000);
      const poll = setInterval(() => {
        if (stdout.includes('超时后仍可继续。')) { clearInterval(poll); clearTimeout(deadline); resolve(); }
      }, 10);
    });
    child.stdin.end('/exit\n');
    expect(await exited).toBe(0);
    expect(stdout + stderr).toContain('Interrupt by user');
  });
});
