import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { readStoredSession } from './helpers/session-store.js';

const secret = 'session-lock-test-key';

describe.skipIf(process.platform === 'win32')('CLI 会话占用与轮次中断', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function directory(name: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `qhy-${name}-`));
    roots.push(path);
    return path;
  }

  async function configure(cwd: string, baseURL: string): Promise<void> {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      timeoutMs: 10000, maxSteps: 10,
      permissions: { allow: ['Bash(sleep:*)'] },
    }));
  }

  async function addLegacyCredential(userDir: string, id: string): Promise<string> {
    const path = join(userDir, '.qhy-coding-agents', 'sessions', id, 'events.jsonl');
    const [first, ...rest] = (await readFile(path, 'utf8')).split('\n');
    const event = JSON.parse(first!) as { data: { record: { config: Record<string, unknown> } } };
    event.data.record.config.webSearchApiKey = 'legacy-fixture-key';
    await writeFile(path, [JSON.stringify(event), ...rest].join('\n'));
    return path;
  }

  it('清洗旧会话日志时阻止另一进程追加，并允许释放锁后继续', async () => {
    const cwd = await directory('scrub-race-cwd');
    const userDir = await directory('scrub-race-user');
    const model = await startLocalOpenAIModel(() => ({ content: '续聊成功' }));
    const conversationId = 'scrub-race';
    const options = { cwd, userDir, conversationId, env: { TEST_MODEL_API_KEY: secret } };
    try {
      await configure(cwd, model.baseURL);
      expect((await startCLI({ ...options, input: '旧会话\n/exit\n' }).done).code).toBe(0);
      const events = await addLegacyCredential(userDir, conversationId);
      const preload = join(cwd, 'pause-before-session-replace.mjs');
      const ready = join(cwd, 'session-replace-ready');
      const proceed = join(cwd, 'session-replace-proceed');
      // 在真正替换日志前暂停，只控制两个 CLI 的交错顺序。
      await writeFile(preload, `
        import { existsSync, writeFileSync } from 'node:fs';
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        import { setTimeout } from 'node:timers/promises';
        const io = createRequire(import.meta.url)('node:fs/promises');
        const rename = io.rename;
        io.rename = async (source, target) => {
          if (source.includes('.events.') && target === ${JSON.stringify(events)}) {
            writeFileSync(${JSON.stringify(ready)}, '', { flag: 'wx' });
            while (!existsSync(${JSON.stringify(proceed)})) await setTimeout(10);
          }
          return rename(source, target);
        };
        syncBuiltinESMExports();
      `);
      const first = startCLI({
        ...options,
        env: { ...options.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        input: '清洗进程续聊\n/exit\n',
      });
      let concurrent: Awaited<typeof first.done>;
      try {
        await expect.poll(() => access(ready).then(() => true, () => false), { timeout: 5000 }).toBe(true);
        concurrent = await startCLI({ ...options, input: '另一个进程续聊\n/exit\n' }).done;
        if (concurrent.code === 0) expect(await readFile(events, 'utf8')).toContain('另一个进程续聊');
      } finally {
        await writeFile(proceed, '');
        await first.done;
      }
      expect((await first.done).code).toBe(0);
      if (concurrent.code === 0) {
        const preserved = (await readFile(events, 'utf8')).includes('另一个进程续聊');
        expect(preserved, '清洗覆盖了另一个进程已经追加的轮次').toBe(true);
      }
      expect(concurrent.code).toBe(2);
      expect(concurrent.stderr).toContain('会话正在被其他进程使用');

      expect((await startCLI({ ...options, input: '另一个进程续聊\n/exit\n' }).done).code).toBe(0);
      const saved = await readFile(events, 'utf8');
      expect(saved).toContain('清洗进程续聊');
      expect(saved).toContain('另一个进程续聊');
      expect(saved).not.toContain('legacy-fixture-key');
      expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('清洗进程续聊');
    } finally {
      await model.close();
    }
  });

  it('拒绝同会话并发进程而不影响占用者，并在 SIGKILL 后释放占用', async () => {
    const cwd = await directory('lock-cwd');
    const userDir = await directory('lock-user');
    const model = await startLocalOpenAIModel(() => ({ content: '首个进程仍可工作' }));
    try {
      await configure(cwd, model.baseURL);
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } });
      await waitForSession(userDir);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('会话尚未创建');

      const second = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret }, input: '不应执行\n/exit\n' });
      const rejected = await second.done;
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain('会话正在被其他进程使用');
      expect(model.requests).toHaveLength(0);

      first.send('正常继续\n');
      await waitFor(() => model.requests.length === 1);
      first.child.kill('SIGKILL');
      await first.done;
      const events = await addLegacyCredential(userDir, id);

      const resumed = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret }, input: '强制结束后恢复\n/exit\n' });
      expect((await resumed.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(await readFile(events, 'utf8')).not.toContain('legacy-fixture-key');
    } finally {
      await model.close();
    }
  });

  it('处理中断当前工具调用，不伪造结果并允许同进程下一轮', async () => {
    const cwd = await directory('cancel-cwd');
    const userDir = await directory('cancel-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'interrupt-call', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'sleep 30' }),
      } }] }
      : { content: '第二轮成功' });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      child.send('运行可中断工具\n');
      await waitFor(() => output.includes('[工具] Bash：开始'));
      child.child.kill('SIGINT');
      await waitFor(() => output.includes('Interrupt by user'));
      child.send('恢复输入\n');
      await waitFor(() => output.includes('第二轮成功'));
      child.end('/exit\n');
      expect((await child.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(JSON.stringify(model.requests[1])).toContain('运行可中断工具');
      expect(JSON.stringify(model.requests[1])).not.toContain('Interrupt by user');
      expect(JSON.stringify(model.requests[1])).not.toContain('interrupt-call');

      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('会话尚未持久化');
      const record = await readStoredSession(userDir, id) as {
        transcript: Array<{ role: string; content: Array<{ type?: string; toolCallId?: string; output?: unknown }> | unknown }>;
        rounds: Array<{ status: string; error?: { message: string } }>;
      };
      expect(record.rounds.map(({ status }) => status)).toEqual(['cancelled', 'succeeded']);
      expect(record.rounds[0]?.error?.message).toBe('Interrupt by user');
      expect(JSON.stringify(record.transcript)).toContain('interrupt-call');
      const toolResult = record.transcript.flatMap(({ role, content }) => role === 'tool' && Array.isArray(content) ? content : [])
        .find(({ toolCallId }) => toolCallId === 'interrupt-call');
      expect(toolResult).toBeUndefined();
    } finally {
      await model.close();
    }
  });

  it('重启后恢复已保存上下文但不重放未完成工具调用', async () => {
    const cwd = await directory('cancel-resume-cwd');
    const userDir = await directory('cancel-resume-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'interrupted-before-restart', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'sleep 30' }),
      } }] }
      : { content: '已恢复中断结果' });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      first.send('运行后重启恢复的工具\n');
      await waitFor(() => output.includes('[工具] Bash：开始'));
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('会话尚未持久化');
      first.child.kill('SIGINT');
      await waitFor(() => output.includes('Interrupt by user'));
      first.end('/exit\n');
      expect((await first.done).code).toBe(0);

      const resumed = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret }, input: '继续恢复\n/exit\n' });
      expect((await resumed.done).code).toBe(0);
      expect(JSON.stringify(model.requests[1])).toContain('运行后重启恢复的工具');
      expect(JSON.stringify(model.requests[1])).not.toContain('Interrupt by user');
      expect(JSON.stringify(model.requests[1])).not.toContain('interrupted-before-restart');
    } finally {
      await model.close();
    }
  });

  it('空闲时 SIGINT 与 /exit 均正常退出', async () => {
    const cwd = await directory('idle-cwd');
    const userDir = await directory('idle-user');
    const model = await startLocalOpenAIModel(() => ({ content: '不应请求' }));
    try {
      await configure(cwd, model.baseURL);
      const interrupted = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } });
      await waitForSession(userDir);
      const [sessionId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!sessionId) throw new Error('会话尚未创建');
      interrupted.child.kill('SIGINT');
      expect((await interrupted.done).code).toBe(0);
      await expect(readFile(join(userDir, '.qhy-coding-agents', 'sessions', sessionId, 'process.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

      const exited = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/exit\n' });
      expect((await exited.done).code).toBe(0);
      const ids = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      for (const id of ids) await expect(readFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'process.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(model.requests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });
});

async function waitForSession(userDir: string): Promise<void> {
  await waitFor(async () => {
    try { return (await readdir(join(userDir, '.qhy-coding-agents', 'sessions'))).length > 0; }
    catch { return false; }
  });
  const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
  if (!id) throw new Error('会话尚未创建');
  await waitFor(async () => {
    try { await readFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'process.lock')); return true; }
    catch { return false; }
  });
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await check()).toBe(true);
}
