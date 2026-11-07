import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';

const secret = 'cli-process-test-key';

describe('compiled CLI process driver', () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function directory(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `qhy-${name}-`));
    roots.push(root);
    return root;
  }

  async function configure(cwd: string, baseURL: string): Promise<void> {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      workspace: '.', timeoutMs: 3000, maxSteps: 10,
      approval: { rules: [
        { toolName: 'write_file', action: 'allow' },
        { toolName: 'Bash', action: 'allow' },
      ] },
    }));
  }

  it.skipIf(process.platform === 'win32')('starts without a conversation ID, accepts input over time, and isolates cwd and user directories', async () => {
    const firstCwd = await directory('driver-first-cwd');
    const secondCwd = await directory('driver-second-cwd');
    const firstUserDir = await directory('driver-first-user');
    const secondUserDir = await directory('driver-second-user');
    const model = await startLocalOpenAIModel((request, index) => {
      if (index % 2 === 1) {
        const prompt = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
        if (prompt === '第一条') {
          return { calls: [{ id: `write-${index}`, type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ path: 'first.txt', content: prompt }),
          } }] };
        }
        return { calls: [{ id: `write-${index}`, type: 'function', function: {
          name: 'Bash', arguments: JSON.stringify({ command: `printf '%s|%s' "$PWD" "$HOME"` }),
        } }] };
      }
      return { content: '已写入。' };
    });
    try {
      await Promise.all([configure(firstCwd, model.baseURL), configure(secondCwd, model.baseURL)]);
      let output = '';
      const first = startCLI({ cwd: firstCwd, userDir: firstUserDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });

      first.send('第一条\n');
      await waitForRequests(model.requests, 2);
      await waitForOutput(() => output, '已写入。', 1);
      first.send('第二条\n');
      await waitForRequests(model.requests, 4);
      await waitForOutput(() => output, '已写入。', 2);
      first.end('/exit\n');
      expect((await first.done).code).toBe(0);
      expect(await readFile(join(firstCwd, 'first.txt'), 'utf8')).toBe('第一条');
      expect(JSON.stringify(model.requests[3])).toContain(`${firstCwd}|${firstUserDir}`);
      expect(model.requests).toHaveLength(4);

      const firstId = findConversationId((await first.done).stderr);
      const recordPath = join(firstUserDir, '.qhy-coding-agents', 'sessions', firstId, 'record.json');
      const stored = await readFile(recordPath, 'utf8');
      const record = JSON.parse(stored) as { workspace: string; transcript: Array<{ role?: string; content: unknown }>; effectiveHistory: unknown[]; rounds: Array<{ status: string }>; config: { apiKeyEnv: string } };
      expect(record.workspace).toBe(firstCwd);
      expect(JSON.stringify(record.transcript)).toContain('第二条');
      expect(JSON.stringify(record.transcript)).toContain('write_file');
      expect(JSON.stringify(record.transcript)).toContain('第一条');
      expect(record.transcript.some(({ role }) => role === 'tool')).toBe(true);
      expect(JSON.stringify(record.transcript)).toContain('printf');
      expect(Array.isArray(record.effectiveHistory)).toBe(true);
      expect(JSON.stringify(record.effectiveHistory)).toContain('第一条');
      expect(record.rounds.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
      expect(record.config.apiKeyEnv).toBe('TEST_MODEL_API_KEY');
      expect(stored).not.toContain(secret);
      if (process.platform !== 'win32') expect((await stat(recordPath)).mode & 0o777).toBe(0o600);

      const restarted = startCLI({ cwd: firstCwd, userDir: firstUserDir, conversationId: firstId, env: { TEST_MODEL_API_KEY: secret } });
      restarted.end('重启后继续\n/exit\n');
      expect((await restarted.done).code).toBe(0);
      expect(JSON.stringify(model.requests[4])).toContain('第一条');
      expect(JSON.stringify(model.requests[4])).toContain('第二条');

      const second = startCLI({ cwd: secondCwd, userDir: secondUserDir, env: { TEST_MODEL_API_KEY: secret } });
      second.end('另一工作区\n/exit\n');
      expect((await second.done).code).toBe(0);
      await expect(readFile(join(firstCwd, 'first.txt'), 'utf8')).resolves.toBe('第一条');
      expect(model.requests).toHaveLength(8);
      expect(JSON.stringify(model.requests[7])).toContain(`${secondCwd}|${secondUserDir}`);
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('tracks write_file baselines in per-message checkpoints, including ignored and newly created files', async () => {
    const cwd = await directory('checkpoint-cwd');
    const userDir = await directory('checkpoint-user');
    await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(cwd, 'note.txt'), 'before');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [
        { id: 'first-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'first' }) } },
        { id: 'repeat-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'within-message' }) } },
        { id: 'ignored-create', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ignored.txt', content: 'ignored' }) } },
      ] };
      if (index === 2) return { content: '第一条已完成。' };
      if (index === 3) return { calls: [{ id: 'second-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'second' }) } }] };
      if (index === 5) return { calls: [{ id: 'late-create', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'late.txt', content: 'late' }) } }] };
      if (index === 7) return { calls: [{ id: 'other-session', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'other-session' }) } }] };
      return { content: '第二条已完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '第一条\n第二条\n第三条\n/exit\n' });
      const result = await child.done;
      expect(result.code).toBe(0);
      const id = findConversationId(result.stderr);
      const record = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json'), 'utf8')) as {
        checkpoints: Array<{ messageId: string; files: Array<{ path: string; backupId: string }> }>;
        backups: Array<{ id: string; path: string; existed: boolean; content?: string }>;
      };
      expect(record.checkpoints).toHaveLength(3);
      const first = record.checkpoints[0]!.files;
      expect(first.map(({ path }) => path).sort()).toEqual(['ignored.txt', 'late.txt', 'note.txt']);
      const original = new Map(record.backups.map((backup) => [backup.id, backup]));
      expect(original.get(first.find(({ path }) => path === 'note.txt')!.backupId)).toMatchObject({ path: 'note.txt', existed: true, content: 'before' });
      expect(original.get(first.find(({ path }) => path === 'ignored.txt')!.backupId)).toMatchObject({ path: 'ignored.txt', existed: false });
      const second = record.checkpoints[1]!.files.find(({ path }) => path === 'note.txt');
      expect(original.get(second!.backupId)).toMatchObject({ path: 'note.txt', existed: true, content: 'within-message' });
      for (const checkpoint of record.checkpoints) {
        const late = checkpoint.files.find(({ path }) => path === 'late.txt');
        expect(late).toBeDefined();
        expect(original.get(late!.backupId)).toMatchObject({ path: 'late.txt', existed: false });
      }
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('second');
      expect(await readFile(join(cwd, 'ignored.txt'), 'utf8')).toBe('ignored');
      expect(await readFile(join(cwd, 'late.txt'), 'utf8')).toBe('late');

      const other = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '独立会话\n/exit\n' });
      const otherResult = await other.done;
      expect(otherResult.code).toBe(0);
      const otherId = findConversationId(otherResult.stderr);
      expect(otherId).not.toBe(id);
      const otherRecord = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', otherId, 'record.json'), 'utf8')) as {
        checkpoints: Array<{ files: Array<{ path: string; backupId: string }> }>;
        backups: Array<{ id: string; content?: string }>;
      };
      expect(otherRecord.checkpoints[0]!.files.map(({ path }) => path)).toEqual(['note.txt']);
      expect(new Map(otherRecord.backups.map(({ id: backupId, content }) => [backupId, content]))
        .get(otherRecord.checkpoints[0]!.files[0]!.backupId)).toBe('second');
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('other-session');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('persists partial output while running and keeps failed round transcript', async () => {
    const cwd = await directory('transcript-cwd');
    const userDir = await directory('transcript-user');
    let finishResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { finishResponse = resolve; });
    const model = await startLocalOpenAIModel(async (_request, index) => {
      if (index === 1) return {
        frames: [
          { delta: { content: '已观察到的部分输出' }, finish_reason: null },
          { delta: {}, finish_reason: 'stop' },
        ],
        endDelayMs: 1000,
      };
      await responseGate;
      return { status: 503, content: 'fixture failure' };
    });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      child.send('第一轮\n');
      await waitForRequests(model.requests, 1);
      await waitForOutput(() => output, '已观察到的部分输出', 1);
      // The generated id is the sole session directory created for this process.
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      expect(id).toBeTruthy();
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id!, 'record.json');
      const running = JSON.parse(await readFile(recordPath, 'utf8')) as { transcript: unknown[]; rounds: Array<{ status: string }>; config: { model: string } };
      expect(JSON.stringify(running.transcript)).toContain('第一轮');
      expect(JSON.stringify(running.transcript)).toContain('已观察到的部分输出');
      expect(running.rounds.map(({ status }) => status)).toEqual(['running']);
      expect(running.config.model).toBe('fixture');

      child.send('第二轮\n');
      await waitForRequests(model.requests, 2);
      finishResponse();
      child.end('/exit\n');
      expect((await child.done).code).toBe(0);
      const failed = JSON.parse(await readFile(recordPath, 'utf8')) as { transcript: unknown[]; effectiveHistory: unknown[]; rounds: Array<{ status: string }> };
      expect(JSON.stringify(failed.transcript)).toContain('第二轮');
      expect(JSON.stringify(failed.effectiveHistory)).not.toContain('第二轮');
      expect(failed.rounds.map(({ status }) => status)).toEqual(['succeeded', 'failed']);
    } finally {
      finishResponse();
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('stops before tool execution when transcript persistence fails', async () => {
    const cwd = await directory('transcript-write-failure-cwd');
    const userDir = await directory('transcript-write-failure-user');
    let finishResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { finishResponse = resolve; });
    const model = await startLocalOpenAIModel(async () => {
      await responseGate;
      return { calls: [{ id: 'write-after-storage-failure', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'must not run' }),
      } }] };
    });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      child.send('写入前停止\n');
      await waitForRequests(model.requests, 1);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('初始会话未创建');
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      await rm(recordPath);
      await mkdir(recordPath);
      finishResponse();
      await waitForOutput(() => output, '错误：', 1);
      child.end('/exit\n');
      await child.done;
      expect(model.requests).toHaveLength(1);
      await expect(readFile(join(cwd, 'must-not-exist.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      finishResponse();
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('creates an empty session with /new and keeps the previous session', async () => {
    const cwd = await directory('new-session-cwd');
    const userDir = await directory('new-session-user');
    const model = await startLocalOpenAIModel(() => ({ content: '回答' }));
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      child.send('/new\n');
      await waitForOutput(() => output, '已新建会话：', 1);
      child.end('/exit\n');
      expect((await child.done).code).toBe(0);

      const sessionRoot = join(userDir, '.qhy-coding-agents', 'sessions');
      const ids = await readdir(sessionRoot);
      expect(ids).toHaveLength(2);
      const records = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(join(sessionRoot, id, 'record.json'), 'utf8')) as { workspace: string; transcript: unknown[] }));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ workspace: cwd, transcript: [] }),
        expect.objectContaining({ workspace: cwd, transcript: [] }),
      ]));
      expect(model.requests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('resumes a session from another directory with its workspace and saved model configuration', async () => {
    const originalCwd = await directory('resume-original-cwd');
    const launchCwd = await directory('resume-launch-cwd');
    const userDir = await directory('resume-user');
    const originalModel = await startLocalOpenAIModel((request) => {
      if (request.messages.at(-1)?.role === 'tool') return { content: '恢复回答' };
      const user = request.messages.filter(({ role }) => role === 'user').at(-1)?.content;
      if (user === '确认恢复') return { calls: [{ id: 'check-workspace', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'pwd' }),
      } }] };
      return { content: '初始回答' };
    });
    const otherModel = await startLocalOpenAIModel(() => ({ content: '错误的启动配置' }));
    try {
      await Promise.all([configure(originalCwd, originalModel.baseURL), configure(launchCwd, otherModel.baseURL)]);
      const first = startCLI({ cwd: originalCwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '创建历史\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!conversationId) throw new Error('初始会话未创建');

      let output = '';
      const resumed = startCLI({ cwd: launchCwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      resumed.send(`/resume ${conversationId}\n`);
      await waitForOutput(() => output, `已继续会话：${conversationId}`, 1);
      resumed.end('确认恢复\n/exit\n');
      const result = await resumed.done;
      expect(result.code).toBe(0);
      expect(originalModel.requests).toHaveLength(3);
      expect(otherModel.requests).toHaveLength(0);
      expect(JSON.stringify(originalModel.requests.at(-1))).toContain(originalCwd);
    } finally {
      await Promise.all([originalModel.close(), otherModel.close()]);
    }
  });

  it.skipIf(process.platform === 'win32')('lists current workspace sessions by default and allows selecting from all sessions', async () => {
    const firstCwd = await directory('list-first-cwd');
    const secondCwd = await directory('list-second-cwd');
    const userDir = await directory('list-user');
    const firstModel = await startLocalOpenAIModel(() => ({ content: '已恢复' }));
    const secondModel = await startLocalOpenAIModel(() => ({ content: '来自第二工作区' }));
    try {
      await Promise.all([configure(firstCwd, firstModel.baseURL), configure(secondCwd, secondModel.baseURL)]);
      const first = startCLI({ cwd: firstCwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/exit\n' });
      expect((await first.done).code).toBe(0);
      const [firstId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!firstId) throw new Error('初始会话未创建');

      let output = '';
      const chooser = startCLI({ cwd: secondCwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      chooser.send('/resume\n');
      await waitForOutput(() => output, '当前工作区会话：', 1);
      const currentListing = output.slice(output.indexOf('当前工作区会话：'), output.indexOf('全部会话：'));
      expect(currentListing).not.toContain(firstId);
      const localIds = (await readdir(join(userDir, '.qhy-coding-agents', 'sessions'))).filter((id) => id !== firstId);
      expect(localIds.length).toBeGreaterThan(0);
      for (const id of localIds) expect(currentListing).toContain(id);

      chooser.send('all\n');
      await waitForOutput(() => output, '全部会话：', 1);
      expect(output.slice(output.indexOf('全部会话：'))).toContain(firstId);
      chooser.send(`${firstId}\n`);
      await waitForOutput(() => output, `已继续会话：${firstId}`, 1);
      chooser.end('跨工作区选择\n/exit\n');
      expect((await chooser.done).code).toBe(0);
      expect(firstModel.requests).toHaveLength(1);
      expect(secondModel.requests).toHaveLength(0);
    } finally {
      await Promise.all([firstModel.close(), secondModel.close()]);
    }
  });

  it.skipIf(process.platform === 'win32')('reports missing sessions and sessions whose workspace no longer exists', async () => {
    const cwd = await directory('invalid-session-cwd');
    const userDir = await directory('invalid-session-user');
    const model = await startLocalOpenAIModel(() => ({ content: '回答' }));
    try {
      await configure(cwd, model.baseURL);
      const missing = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/resume missing-session\n/exit\n' });
      const missingResult = await missing.done;
      expect(missingResult.code).toBe(0);
      expect(missingResult.stdout).toContain('会话记录不存在：missing-session');

      const create = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/exit\n' });
      expect((await create.done).code).toBe(0);
      const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!conversationId) throw new Error('初始会话未创建');
      await rm(cwd, { recursive: true, force: true });
      const otherCwd = await directory('invalid-session-launch-cwd');
      await configure(otherCwd, model.baseURL);
      const invalidWorkspace = startCLI({ cwd: otherCwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: `/resume ${conversationId}\n/exit\n` });
      const invalidResult = await invalidWorkspace.done;
      expect(invalidResult.code).toBe(0);
      expect(invalidResult.stdout).toContain('会话工作区不可用');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('drops an interrupted tool call with no saved result when resuming', async () => {
    const cwd = await directory('recovery-orphan-cwd');
    const userDir = await directory('recovery-orphan-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'never-finished-call', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'sleep 1' }),
      } }] }
      : { content: '已从中断会话继续。' });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const interrupted = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      interrupted.send('运行慢工具\n');
      await waitForOutput(() => output, '[工具] Bash：开始', 1);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('中断会话尚未持久化');
      interrupted.child.kill('SIGKILL');
      await interrupted.done;

      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      const interruptedRecord = await readFile(recordPath, 'utf8');
      expect(interruptedRecord).toContain('never-finished-call');

      const resumed = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret } });
      resumed.end('继续\n/exit\n');
      expect((await resumed.done).code).toBe(0);
      const request = model.requests.at(-1)!;
      expect(JSON.stringify(request.messages)).not.toContain('never-finished-call');
      expect(request.messages.some(({ role }) => role === 'tool')).toBe(false);
      expect(await readFile(recordPath, 'utf8')).toContain('never-finished-call');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('reuses a saved tool result with its call ID and marks the final answer as unobserved', async () => {
    const cwd = await directory('recovery-partial-cwd');
    const userDir = await directory('recovery-partial-user');
    let releaseSecondRequest!: () => void;
    const secondRequestGate = new Promise<void>((resolve) => { releaseSecondRequest = resolve; });
    const model = await startLocalOpenAIModel(async (_request, index) => {
      if (index === 1) return { calls: [{ id: 'saved-result-call', type: 'function', function: {
        name: 'runtimeInfo', arguments: '{}',
      } }] };
      if (index === 2) await secondRequestGate;
      return { content: '恢复后回答。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const interrupted = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } });
      interrupted.send('获取运行信息\n');
      await waitForRequests(model.requests, 2);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('中断会话尚未持久化');
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      const saved = await readFile(recordPath, 'utf8');
      expect(saved).toContain('"toolCallId":"saved-result-call"');
      interrupted.child.kill('SIGKILL');
      await interrupted.done;

      const resumed = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret } });
      resumed.end('继续未完成任务\n/exit\n');
      expect((await resumed.done).code).toBe(0);
      const recovered = model.requests.at(-1)!.messages;
      const assistantCall = recovered.find(({ role, ...message }) => role === 'assistant' && JSON.stringify(message).includes('saved-result-call'));
      const toolResult = recovered.find(({ role }) => role === 'tool');
      expect(assistantCall).toBeDefined();
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult)).toContain('saved-result-call');
      expect(JSON.stringify(toolResult)).toContain('probe');
      expect(JSON.stringify(recovered)).toContain('未观察到该轮最终结果');
      expect(recovered.filter(({ role, ...message }) => role === 'assistant' && JSON.stringify(message).includes('saved-result-call'))).toHaveLength(1);
      expect(recovered.filter(({ role }) => role === 'tool')).toHaveLength(1);

      const afterRecovery = JSON.parse(await readFile(recordPath, 'utf8')) as { rounds: Array<{ recovered?: boolean }> };
      expect(afterRecovery.rounds[0]?.recovered).toBe(true);
      const resumedAgain = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret } });
      resumedAgain.end('再确认一次\n/exit\n');
      expect((await resumedAgain.done).code).toBe(0);
      const nextRequest = model.requests.at(-1)!.messages;
      expect(nextRequest.filter(({ role, ...message }) => role === 'assistant' && JSON.stringify(message).includes('saved-result-call'))).toHaveLength(1);
      expect(nextRequest.filter(({ role }) => role === 'tool')).toHaveLength(1);
    } finally {
      releaseSecondRequest();
      await model.close();
    }
  });
});

async function waitForRequests(requests: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(requests).toHaveLength(count);
}

async function waitForOutput(readOutput: () => string, text: string, occurrences: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (readOutput().split(text).length - 1 < occurrences && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(readOutput().split(text).length - 1).toBeGreaterThanOrEqual(occurrences);
}

function findConversationId(stderr: string): string {
  const started = stderr.split('\n').find((line) => line.includes('"event":"run.started"'));
  if (!started) throw new Error('CLI did not log run.started');
  const event = JSON.parse(started) as { conversationId?: string };
  if (!event.conversationId) throw new Error('CLI did not create a conversation ID');
  return event.conversationId;
}
