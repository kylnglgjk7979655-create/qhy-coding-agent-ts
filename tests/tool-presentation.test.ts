import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const cli = resolve('dist/cli.js');
const secret = 'tool-presentation-test-secret';

describe('CLI 工具状态、历史与冒烟', () => {
  let cwd: string;
  let model: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;

  afterEach(async () => {
    await model?.close();
    model = undefined;
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0]) {
    cwd = await mkdtemp(join(tmpdir(), 'qhy-tool-presentation-'));
    model = await startLocalOpenAIModel(respond);
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
      workspace: '.', timeoutMs: 3000, maxSteps: 20,
    }));
    return model;
  }

  function run(input: string, args: string[] = [], onStdout?: (stdout: string) => void) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd, env: { ...process.env, TEST_MODEL_API_KEY: secret }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onStdout?.(stdout); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('exit', (code) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
      child.stdin.end(input);
    });
  }

  it('显示执行事件的四种状态，且终端不泄露参数、文件内容或异常', async () => {
    let enterFinalResponse!: () => void;
    let releaseFinalResponse!: () => void;
    const finalResponseReached = new Promise<void>((resolve) => { enterFinalResponse = resolve; });
    const finalResponseGate = new Promise<void>((resolve) => { releaseFinalResponse = resolve; });
    const fixture = await setup(async (_request, index) => {
      if (index === 1) return { calls: [
        { id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'secret-path.txt' }) } },
        { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'secret-path.txt', content: 'secret-content' }) } },
      ] };
      if (index === 2) return { calls: [
        { id: 'reject-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'secret-path.txt', content: 'secret-content', extra: 'secret-argument' }) } },
        { id: 'fail-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing-secret.txt' }) } },
      ] };
      enterFinalResponse();
      await finalResponseGate;
      return { content: '处理完成。' };
    });
    await writeFile(join(cwd, 'secret-path.txt'), 'secret-content');
    let liveStdout = '';
    const resultPromise = run('处理工具调用\n/exit\n', [], (stdout) => { liveStdout = stdout; });
    await finalResponseReached;
    expect(liveStdout).toContain('[工具] read_file：开始');
    expect(liveStdout).toContain('[工具] read_file：成功');
    expect(liveStdout).toContain('[工具] write_file：拒绝');
    expect(liveStdout).toContain('[工具] read_file：失败');
    expect(liveStdout).not.toContain('处理完成。');
    releaseFinalResponse();
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[工具] read_file：开始');
    expect(result.stdout).toContain('[工具] read_file：成功');
    expect(result.stdout).toContain('[工具] write_file：成功');
    expect(result.stdout).toContain('[工具] write_file：拒绝');
    expect(result.stdout).toContain('[工具] read_file：失败');
    expect(result.stdout).not.toContain('secret-path.txt');
    expect(result.stdout).not.toContain('secret-content');
    expect(result.stdout).not.toContain('secret-argument');
    const eventLines = result.stdout.split('\n').filter((line) => line.startsWith('[工具]'));
    expect(eventLines.filter((line) => line.includes('read_file'))).toHaveLength(4);
    expect(eventLines.filter((line) => line.endsWith('：开始'))).toHaveLength(3);
    expect(eventLines.filter((line) => line.endsWith('：成功'))).toHaveLength(2);
    expect(eventLines.filter((line) => line.endsWith('：失败'))).toHaveLength(1);
    expect(eventLines.filter((line) => line.endsWith('：拒绝'))).toHaveLength(1);
    expect(result.stdout.indexOf(eventLines.at(-1)!)).toBeLessThan(result.stdout.indexOf('处理完成。'));
    expect(fixture.requests).toHaveLength(3);
  });

  it('保留旧历史原文，并保存、重载及续聊新的工具结果', async () => {
    const fixture = await setup((_request, index) => index === 1
      ? { calls: [{ id: 'read-new', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] }
      : { content: `续聊回答${index}` });
    await writeFile(join(cwd, 'note.txt'), 'new-content');
    const conversationId = 'mixed-history';
    const historyPath = join(cwd, '.agent', 'conversations', `${conversationId}.json`);
    const oldToolCall = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'legacy-call', toolName: 'runtimeInfo', input: {} }] };
    const oldToolResult = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'legacy-call', toolName: 'runtimeInfo', output: {
        type: 'json', value: { workspace: '/legacy/workspace', probe: 'legacy-probe' },
      } }],
    };
    const oldHistory = [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      oldToolCall,
      oldToolResult,
    ];
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
    await writeFile(historyPath, JSON.stringify(oldHistory));

    const first = await run('读取并继续\n/exit\n', ['--conversation-id', conversationId]);
    expect(first.code).toBe(0);
    const saved = JSON.parse(await readFile(historyPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(saved.slice(0, 4)).toEqual(oldHistory);
    const savedNewToolResult = saved.find((message) => message.role === 'tool' && JSON.stringify(message).includes('read-new'));
    expect(savedNewToolResult).toBeDefined();
    const newResultPart = (savedNewToolResult?.content as Array<Record<string, unknown>>)
      .find((part) => part.type === 'tool-result');
    expect(newResultPart?.output).toEqual({
      type: 'json', value: { is_error: false, output: { content: 'new-content' } },
    });

    const second = await run('继续上一轮\n/exit\n', ['--conversation-id', conversationId]);
    expect(second.code).toBe(0);
    expect(fixture.requests.at(-1)?.messages.some((message) => message.role === 'tool' && message.content.includes('new-content'))).toBe(true);
    const afterReload = JSON.parse(await readFile(historyPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(afterReload.slice(0, 4)).toEqual(oldHistory);
    expect(fixture.requests).toHaveLength(3);
  });

  it('本地工具冒烟识别统一成功包装并校验读取探针及最终回答', async () => {
    await setup((request, index) => {
      if (index === 1) {
        const prompt = request.messages.find(({ role }) => role === 'user')?.content ?? '';
        const path = prompt.match(/读取 (\.agent-smoke-[a-f0-9-]+\.txt)/)?.[1];
        if (!path) throw new Error('缺少冒烟探针路径');
        return { calls: [{ id: 'smoke-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] };
      }
      const toolResult = request.messages.find(({ role }) => role === 'tool');
      return { content: toolResult?.content ?? '' };
    });
    const result = await run('', ['--smoke-tool']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('"toolSmokePassed":true');
    expect(model?.requests).toHaveLength(2);
    const toolMessage = model?.requests[1]?.messages.find(({ role }) => role === 'tool');
    expect(toolMessage?.content).toMatch(/"is_error":false,"output":\{"content":"[a-f0-9-]+"\}\}/);
  });
});
