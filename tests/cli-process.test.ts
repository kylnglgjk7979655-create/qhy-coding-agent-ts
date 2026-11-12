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
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      timeoutMs: 3000, maxSteps: 10,
      permissions: { allow: ['Write', 'Bash(printf:*)', 'Bash(pwd)', 'Bash(sleep:*)'] },
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
        if (prompt === '重启后继续') {
          return { calls: [{ id: `restart-write-${index}`, type: 'function', function: {
            name: 'write_file', arguments: JSON.stringify({ path: 'first.txt', content: '重启后不应覆盖' }),
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
      expect(await readFile(join(firstCwd, 'first.txt'), 'utf8')).toBe('第一条');
      expect(JSON.stringify(model.requests[5])).toContain('写入冲突');

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

  it.skipIf(process.platform === 'win32')('automatically handles background task notifications in their session after the current turn', async () => {
    const cwd = await directory('background-notification-cwd');
    const userDir = await directory('background-notification-user');
    const model = await startLocalOpenAIModel((request, index) => {
      const userText = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n');
      if (userText.includes('任务：后台子任务')) return { content: '后台调查结果。' };
      if (index === 1) return { calls: [{ id: 'notification-launch', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '后台调查', prompt: '后台子任务', background: true }),
      } }] };
      if (userText.includes('后台子 Agent 已完成')) return { content: '已收到后台调查结果。' };
      return { content: '主轮次已完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      let stdout = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { stdout = text; });
      child.send('启动后台调查\n');
      await waitForRequests(model.requests, 3);
      await waitForOutput(() => stdout, '已收到后台调查结果。', 1);
      child.end('/exit\n');
      const result = await child.done;
      expect(result.code).toBe(0);
      expect(model.requests).toHaveLength(4);
      expect(JSON.stringify(model.requests[1])).toContain('任务：后台子任务');
      expect(JSON.stringify(model.requests[2])).toContain('启动后台调查');
      expect(JSON.stringify(model.requests[3])).toContain('后台子 Agent 已完成');
      const id = findConversationId(result.stderr);
      const record = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json'), 'utf8')) as {
        transcript: Array<{ role?: string; content: unknown }>;
        rounds: Array<{ status: string }>;
      };
      expect(JSON.stringify(record.transcript)).toContain('后台子 Agent 已完成');
      expect(JSON.stringify(record.transcript)).toContain('已收到后台调查结果。');
      expect(record.rounds.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
      expect(result.stdout).toContain('[后台任务通知] 后台调查：succeeded');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('compiled CLI keeps delegated tool permissions and approval history in the child context', async () => {
    const cwd = await directory('delegated-permissions-cwd');
    const userDir = await directory('delegated-permissions-user');
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await mkdir(join(cwd, 'private'), { recursive: true });
    await writeFile(join(cwd, 'private', 'secret.txt'), 'CHILD_PRIVATE_SECRET');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'cli-delegate', type: 'function', function: { name: 'agent', arguments: JSON.stringify({
        description: '验证子 Agent 权限',
        prompt: '子任务审批上下文标记 CHILD_TASK_SENTINEL：读取并搜索 private/secret.txt，然后写入 child-output.txt。',
      }) } }] };
      if (index === 2) return { calls: [
        { id: 'child-read-denied', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'private/secret.txt' }) } },
        { id: 'child-grep-denied', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'CHILD_PRIVATE_SECRET', path: 'private' }) } },
        { id: 'child-read-settings', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '.agent/settings.json' }) } },
        { id: 'child-change-settings', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '.agent/settings.json', content: JSON.stringify({ permissions: { allow: ['Read', 'Grep'] } }) }) } },
        { id: 'child-write-approved', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'child-output.txt', content: 'CHILD_WRITE_APPROVED' }) } },
      ] };
      if (index === 3) return { calls: [
        { id: 'child-read-after-settings-change', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'private/secret.txt' }) } },
        { id: 'child-grep-after-settings-change', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'CHILD_PRIVATE_SECRET', path: 'private' }) } },
      ] };
      if (index === 4) return { content: '子 Agent 已处理权限检查。' };
      return { content: '父 Agent 已收到子 Agent 报告。' };
    }, () => ({ content: 'approve' }));
    try {
      await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
        model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
        timeoutMs: 5000, maxSteps: 8, approval: { mode: 'auto', timeoutMs: 3000 },
        permissions: { deny: ['Read(./private/**)', 'Grep(./private)'] },
      }));
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '父会话私有标记 PARENT_PRIVATE_SENTINEL\n/exit\n' });
      const result = await child.done;

      expect(result.code).toBe(0);
      expect(model.requests).toHaveLength(5);
      expect(model.requests[1]!.tools.map(({ function: fn }) => fn.name)).not.toContain('agent');
      const childResults = model.requests[2]!.messages.filter(({ role }) => role === 'tool');
      expect(childResults).toHaveLength(5);
      expect(childResults.slice(0, 2).map(({ content }) => JSON.parse(content))).toEqual([
        expect.objectContaining({ is_error: true, error: expect.objectContaining({ code: 'PERMISSION_DENIED' }) }),
        expect.objectContaining({ is_error: true, error: expect.objectContaining({ code: 'PERMISSION_DENIED' }) }),
      ]);
      expect(JSON.parse(childResults[2]!.content)).toMatchObject({ is_error: false });
      expect(JSON.parse(childResults[3]!.content)).toMatchObject({ is_error: false });
      expect(JSON.parse(childResults[4]!.content)).toMatchObject({ is_error: false });
      expect(model.requests[3]!.messages.filter(({ role }) => role === 'tool').slice(-2).map(({ content }) => JSON.parse(content))).toEqual([
        expect.objectContaining({ is_error: true, error: expect.objectContaining({ code: 'PERMISSION_DENIED' }) }),
        expect.objectContaining({ is_error: true, error: expect.objectContaining({ code: 'PERMISSION_DENIED' }) }),
      ]);
      expect(model.approvalRequests).toHaveLength(2);
      const approvalContext = JSON.stringify(model.approvalRequests.map(({ messages }) => messages));
      expect(approvalContext).toContain('CHILD_TASK_SENTINEL');
      expect(approvalContext).toContain('child-output.txt');
      expect(approvalContext).toContain('settings.json');
      expect(approvalContext).not.toContain('PARENT_PRIVATE_SENTINEL');
      expect(await readFile(join(cwd, 'child-output.txt'), 'utf8')).toBe('CHILD_WRITE_APPROVED');
      expect(JSON.parse(await readFile(join(cwd, '.agent', 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['Read', 'Grep'] } });
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('switching sessions preserves each session’s in-process file baseline', async () => {
    const cwd = await directory('session-baseline-cwd');
    const userDir = await directory('session-baseline-user');
    await writeFile(join(cwd, 'note.txt'), 'initial');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'read-session-baseline', type: 'function', function: {
        name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }),
      } }] };
      if (index === 3) return { calls: [{ id: 'write-other-session', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'other session' }),
      } }] };
      if (index === 5) return { calls: [{ id: 'write-resumed-session', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'resumed session' }),
      } }] };
      return { content: '已处理。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const child = startCLI({
        cwd, userDir, conversationId: 'baseline-session', env: { TEST_MODEL_API_KEY: secret },
        input: '读取基线\n/new\n独立会话检查\n/resume baseline-session\n按原基线写入\n/exit\n',
      });
      const result = await child.done;
      expect(result.code).toBe(0);
      expect(JSON.stringify(model.requests[3])).toContain('尚未读取');
      expect(JSON.stringify(model.requests[5])).not.toContain('尚未读取');
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('resumed session');
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
        { id: 'initial-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'first-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'first' }) } },
        { id: 'repeat-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'within-message' }) } },
        { id: 'ignored-create', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ignored.txt', content: 'ignored' }) } },
      ] };
      if (index === 2) return { content: '第一条已完成。' };
      if (index === 3) return { calls: [{ id: 'second-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'second' }) } }] };
      if (index === 5) return { calls: [{ id: 'late-create', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'late.txt', content: 'late' }) } }] };
      if (index === 7) return { calls: [
        { id: 'other-session', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'other-session' }) } },
      ] };
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
      expect(otherRecord.checkpoints[0]!.files).toEqual([]);
      expect(otherRecord.backups).toEqual([]);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('second');
      expect(JSON.stringify(model.requests[7])).toContain('尚未读取');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('previews, refreshes, and confirms a rewind without changing untracked files', async () => {
    const cwd = await directory('rewind-cwd');
    const userDir = await directory('rewind-user');
    await writeFile(join(cwd, 'note.txt'), 'before');
    await writeFile(join(cwd, 'untracked.txt'), 'leave this alone');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'rewind-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'rewind-note', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'after' }) } },
        { id: 'rewind-created', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: 'remove me' }) } },
      ] }
      : index === 2 ? { content: '编辑已完成。' } : { content: '已收到恢复记录。' });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const cli = startCLI({ cwd, userDir, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      cli.send('编辑文件\n');
      await waitForRequests(model.requests, 2);
      await waitForOutput(() => output, '编辑已完成。', 1);

      cli.send('/rewind\n');
      await waitForOutput(() => output, '选择要预览的用户消息恢复点', 1);
      cli.send('\r');
      await waitForOutput(() => output, '改动统计', 1);
      expect(output).toContain('note.txt');
      expect(output).toContain('created.txt');
      expect(output).toContain('删除');
      expect(output).toContain('+');

      cli.send('no\n');
      await waitForOutput(() => output, '已取消文件检查点恢复', 1);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after');
      expect(await readFile(join(cwd, 'created.txt'), 'utf8')).toBe('remove me');

      cli.send('/rewind\n');
      await waitForOutput(() => output, '选择要预览的用户消息恢复点', 2);
      cli.send('\r');
      await waitForOutput(() => output, '改动统计', 2);

      await writeFile(join(cwd, 'note.txt'), 'external change');
      cli.send('yes\n');
      await waitForOutput(() => output, '文件状态已变化，预览已刷新', 1);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('external change');
      expect(await readFile(join(cwd, 'created.txt'), 'utf8')).toBe('remove me');

      cli.send('yes\n');
      await waitForOutput(() => output, '恢复结果', 1);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('before');
      await expect(readFile(join(cwd, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('leave this alone');

      cli.send('恢复后继续\n');
      await waitForRequests(model.requests, 3);
      expect(JSON.stringify(model.requests[2])).toContain('恢复文件检查点');
      expect(JSON.stringify(model.requests[2])).toContain('note.txt');
      expect(JSON.stringify(model.requests[2])).toContain('成功');
      cli.end('/exit\n');
      expect((await cli.done).code).toBe(0);

      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('会话未保存');
      const record = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json'), 'utf8')) as {
        transcript: unknown[];
        effectiveHistory: unknown[];
        checkpoints: Array<{ id: string }>;
      };
      expect(record.checkpoints).toHaveLength(2);
      expect(JSON.stringify(record.transcript)).toContain('恢复文件检查点');
      expect(JSON.stringify(record.transcript)).toContain('删除');
      expect(JSON.stringify(record.effectiveHistory)).toContain('note.txt');
      expect(JSON.stringify(record.effectiveHistory)).toContain('成功');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('binds identical rewind messages to distinct checkpoints and refuses piped selection', async () => {
    const cwd = await directory('rewind-duplicate-cwd');
    const userDir = await directory('rewind-duplicate-user');
    await writeFile(join(cwd, 'note.txt'), 'before-first-message');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1 || index === 3) return { calls: [{
        id: `duplicate-write-${index}`,
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: `after-${index}` }) },
      }] };
      return { content: '完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '重复请求\n重复请求\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('会话未保存');
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        checkpoints: Array<{ id: string; messageId: string }>;
        rounds: Array<{ id: string; transcriptStart?: number }>;
        transcript: Array<{ role: string; content: unknown }>;
      };
      expect(record.checkpoints).toHaveLength(2);

      let output = '';
      const chooser = startCLI({ cwd, userDir, conversationId: id, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      chooser.send('/rewind\n');
      await waitForOutput(() => output, '选择要预览的用户消息恢复点', 1);
      await waitForOutput(() => output, '重复请求', 2);
      chooser.send('\u001b[A');
      chooser.send('\r');
      await waitForOutput(() => output, `消息 ${record.checkpoints[0]!.messageId}`, 1);
      chooser.send('yes\n');
      await waitForOutput(() => output, '恢复结果', 1);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('before-first-message');
      chooser.end('/exit\n');
      expect((await chooser.done).code).toBe(0);

      const firstRound = record.rounds.find(({ id: roundId }) => roundId === record.checkpoints[0]!.messageId);
      if (firstRound?.transcriptStart === undefined) throw new Error('检查点轮次缺少 transcript 起点');
      record.transcript[firstRound.transcriptStart] = { role: 'user', content: '' };
      await writeFile(recordPath, JSON.stringify(record));
      let emptyOutput = '';
      const emptyChooser = startCLI({ cwd, userDir, conversationId: id, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { emptyOutput = text; });
      emptyChooser.send('/rewind\n');
      await waitForOutput(() => emptyOutput, '（无文本用户消息）', 1);
      emptyChooser.send('\u001b');
      await waitForOutput(() => emptyOutput, '已取消文件检查点选择', 1);
      emptyChooser.end('/exit\n');
      expect((await emptyChooser.done).code).toBe(0);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('before-first-message');

      const legacyRound = record.rounds.find(({ id: roundId }) => roundId === record.checkpoints[0]!.messageId);
      if (!legacyRound) throw new Error('检查点轮次未保存');
      delete legacyRound.transcriptStart;
      await writeFile(recordPath, JSON.stringify(record));
      let legacyOutput = '';
      const legacyChooser = startCLI({ cwd, userDir, conversationId: id, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { legacyOutput = text; });
      legacyChooser.send('/rewind\n');
      await waitForOutput(() => legacyOutput, `原始用户消息不可用（检查点 ${record.checkpoints[0]!.id}）`, 1);
      legacyChooser.send('\u001b[A\r');
      await waitForOutput(() => legacyOutput, `消息 ${record.checkpoints[0]!.messageId}`, 1);
      legacyChooser.end('/cancel\n/exit\n');
      expect((await legacyChooser.done).code).toBe(0);

      const noninteractive = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret }, input: '/rewind\n/exit\n' });
      const result = await noninteractive.done;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('此选择需要交互终端');
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('before-first-message');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('refuses to start a rewind when a checkpoint backup is missing', async () => {
    const cwd = await directory('rewind-missing-backup-cwd');
    const userDir = await directory('rewind-missing-backup-user');
    await writeFile(join(cwd, 'note.txt'), 'before');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'read-before-rewind', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } },
        { id: 'write-before-rewind', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'after' }) } },
      ] }
      : { content: '完成。' });
    try {
      await configure(cwd, model.baseURL);
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '编辑文件\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const id = findConversationId((await first.done).stderr);
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as { backups: unknown[] };
      record.backups = [];
      await writeFile(recordPath, JSON.stringify(record));

      let output = '';
      const resumed = startCLI({ cwd, userDir, conversationId: id, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      resumed.send('/rewind\n');
      await waitForOutput(() => output, '选择要预览的用户消息恢复点', 1);
      resumed.send('\r');
      await waitForOutput(() => output, '检查点备份不完整', 1);
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after');
      expect(model.requests).toHaveLength(2);
      resumed.end('/exit\n');
      expect((await resumed.done).code).toBe(0);
      const saved = JSON.parse(await readFile(recordPath, 'utf8')) as { transcript: unknown[] };
      expect(JSON.stringify(saved.transcript)).not.toContain('恢复文件检查点请求');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('continues restoring files after one target fails and records each result', async () => {
    const cwd = await directory('rewind-partial-cwd');
    const userDir = await directory('rewind-partial-user');
    await writeFile(join(cwd, 'blocked.txt'), 'blocked-before');
    await writeFile(join(cwd, 'good.txt'), 'good-before');
    await writeFile(join(cwd, 'last.txt'), 'last-before');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'read-before-rewind', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'blocked.txt' }) } },
        { id: 'read-good-before-rewind', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'good.txt' }) } },
        { id: 'read-last-before-rewind', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'last.txt' }) } },
        { id: 'write-blocked', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'blocked-after' }) } },
        { id: 'write-good', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'good.txt', content: 'good-after' }) } },
        { id: 'write-last', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'last.txt', content: 'last-after' }) } },
      ] }
      : { content: '完成。' });
    try {
      await configure(cwd, model.baseURL);
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '编辑文件\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const id = findConversationId((await first.done).stderr);
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      let output = '';
      const resumed = startCLI({ cwd, userDir, conversationId: id, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      resumed.send('/rewind\n');
      await waitForOutput(() => output, '选择要预览的用户消息恢复点', 1);
      resumed.send('\r');
      await waitForOutput(() => output, '改动统计', 1);

      await rm(join(cwd, 'blocked.txt'));
      await mkdir(join(cwd, 'blocked.txt'));
      resumed.send('yes\n');
      await waitForOutput(() => output, '文件状态已变化，预览已刷新', 1);
      resumed.send('yes\n');
      await waitForOutput(() => output, '恢复结果', 1);
      expect(output).toContain('blocked.txt：失败');
      expect(output).toContain('good.txt：成功');
      expect(output).toContain('last.txt：成功');
      expect(await readFile(join(cwd, 'good.txt'), 'utf8')).toBe('good-before');
      expect(await readFile(join(cwd, 'last.txt'), 'utf8')).toBe('last-before');

      resumed.end('/exit\n');
      expect((await resumed.done).code).toBe(0);
      const saved = JSON.parse(await readFile(recordPath, 'utf8')) as { transcript: unknown[] };
      expect(JSON.stringify(saved.transcript)).toContain('blocked.txt：失败');
      expect(JSON.stringify(saved.transcript)).toContain('good.txt：成功');
      expect(JSON.stringify(saved.transcript)).toContain('last.txt：成功');
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

  it.skipIf(process.platform === 'win32').each(['/new', '/clear'])('creates an empty session with %s and keeps the previous session', async (command) => {
    const cwd = await directory('new-session-cwd');
    const userDir = await directory('new-session-user');
    const model = await startLocalOpenAIModel(() => ({ content: '回答' }));
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const child = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      child.send('保留的原对话\n');
      await waitForOutput(() => output, '回答', 1);
      child.send(`${command}\n`);
      await waitForOutput(() => output, '已新建会话：', 1);
      child.end('/exit\n');
      expect((await child.done).code).toBe(0);

      const sessionRoot = join(userDir, '.qhy-coding-agents', 'sessions');
      const ids = await readdir(sessionRoot);
      expect(ids).toHaveLength(2);
      const records = await Promise.all(ids.map(async (id) => ({
        id,
        record: JSON.parse(await readFile(join(sessionRoot, id, 'record.json'), 'utf8')) as { workspace: string; transcript: unknown[] },
      })));
      const previous = records.find(({ record }) => JSON.stringify(record.transcript).includes('保留的原对话'));
      const current = records.find(({ record }) => record.transcript.length === 0);
      expect(previous?.record.workspace).toBe(cwd);
      expect(current?.record.workspace).toBe(cwd);
      expect(model.requests).toHaveLength(1);

      const resumedNew = startCLI({ cwd, userDir, conversationId: current!.id, env: { TEST_MODEL_API_KEY: secret }, input: '新会话内容\n/exit\n' });
      expect((await resumedNew.done).code).toBe(0);
      expect(model.requests[1]?.messages.filter(({ role }) => role !== 'system')).toEqual([
        { role: 'user', content: '新会话内容' },
      ]);

      const resumed = startCLI({ cwd, userDir, conversationId: previous!.id, env: { TEST_MODEL_API_KEY: secret }, input: '恢复旧对话\n/exit\n' });
      expect((await resumed.done).code).toBe(0);
      expect(JSON.stringify(model.requests[2])).toContain('保留的原对话');
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

  it.skipIf(process.platform === 'win32')('ignores stale workspace history when resuming a user-level session', async () => {
    const cwd = await directory('resume-stale-history-cwd');
    const userDir = await directory('resume-stale-history-user');
    const model = await startLocalOpenAIModel(() => ({ content: '继续完成' }));
    try {
      await configure(cwd, model.baseURL);
      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '用户级会话中的原始消息\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const durableSessionId = findConversationId((await first.done).stderr);

      await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
      await writeFile(join(cwd, '.agent', 'conversations', `${durableSessionId}.json`), JSON.stringify([
        { role: 'user', content: '过期工作区历史' },
      ]));
      const resumed = startCLI({ cwd, userDir, conversationId: durableSessionId, env: { TEST_MODEL_API_KEY: secret }, input: '继续用户级会话\n/exit\n' });
      expect((await resumed.done).code).toBe(0);

      const request = model.requests.at(-1)!;
      expect(JSON.stringify(request)).toContain('用户级会话中的原始消息');
      expect(JSON.stringify(request)).not.toContain('过期工作区历史');
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('lists current workspace sessions by default and allows selecting from all sessions', async () => {
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
      const sourceRecord = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', firstId, 'record.json'), 'utf8')) as Record<string, unknown>;
      for (let index = 0; index < 14; index += 1) {
        const id = `viewport-${String(index).padStart(2, '0')}`;
        const record = {
          ...sourceRecord,
          id,
          workspace: secondCwd,
          updatedAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(),
          title: index === 0 ? `尾部目标\n${'很长的标题'.repeat(30)}` : `候选-${index}`,
          config: { ...(sourceRecord.config as Record<string, unknown>), workspace: secondCwd },
        };
        await mkdir(join(userDir, '.qhy-coding-agents', 'sessions', id), { recursive: true });
        await writeFile(join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json'), JSON.stringify(record));
      }

      let output = '';
      const chooser = startCLI({ cwd: secondCwd, userDir, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      chooser.send('/resume\n');
      await waitForOutput(() => output, '当前工作区会话', 1);
      chooser.send('\u001b[B'.repeat(14));
      await waitForOutput(() => output.slice(output.lastIndexOf('\u001b[2J')), '❯ 尾部目标', 1);
      const lastScreen = output.slice(output.lastIndexOf('\u001b[2J'));
      expect(lastScreen).toContain('❯ 尾部目标');
      expect(lastScreen).toContain('…');
      expect(lastScreen).not.toContain('\n很长的标题');
      expect(lastScreen).toContain('viewport-00');
      chooser.send('\u001b');
      chooser.send('/resume\n');
      await waitForOutput(() => output.slice(output.lastIndexOf('\u001b[2J')), '当前工作区会话', 1);
      const firstScreenStart = output.indexOf('\u001b[2J');
      const nextScreenStart = output.indexOf('\u001b[2J', firstScreenStart + 1);
      const currentListing = output.slice(firstScreenStart, nextScreenStart);
      expect(currentListing).not.toContain(firstId);
      const localIds = (await readdir(join(userDir, '.qhy-coding-agents', 'sessions'))).filter((id) => id !== firstId);
      expect(localIds.length).toBeGreaterThan(14);
      expect(currentListing).toContain('viewport-13');

      chooser.send('\u001b[B\r');
      await waitForOutput(() => output, '全部工作区会话', 1);
      expect(output).toContain(firstId);
      chooser.send('\u001b[B');
      chooser.send('\r');
      await waitForOutput(() => output, `已继续会话：${firstId}`, 1);
      chooser.end('跨工作区选择\n/exit\n');
      expect((await chooser.done).code).toBe(0);
      expect(firstModel.requests).toHaveLength(1);
      expect(secondModel.requests).toHaveLength(0);
    } finally {
      await Promise.all([firstModel.close(), secondModel.close()]);
    }
  });

  it.skipIf(process.platform !== 'linux')('disambiguates sessions with identical titles by showing their IDs', async () => {
    const cwd = await directory('duplicate-title-cwd');
    const userDir = await directory('duplicate-title-user');
    const model = await startLocalOpenAIModel(() => ({ content: '未预期的请求' }));
    try {
      await configure(cwd, model.baseURL);
      const create = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/exit\n' });
      expect((await create.done).code).toBe(0);
      const [sourceId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!sourceId) throw new Error('初始会话未创建');
      const sessionRoot = join(userDir, '.qhy-coding-agents', 'sessions');
      const source = JSON.parse(await readFile(join(sessionRoot, sourceId, 'record.json'), 'utf8')) as Record<string, unknown>;
      for (const [id, updatedAt] of [
        ['duplicate-title-first', '2100-01-02T00:00:00.000Z'],
        ['duplicate-title-second', '2100-01-01T00:00:00.000Z'],
      ] as const) {
        await mkdir(join(sessionRoot, id), { recursive: true });
        await writeFile(join(sessionRoot, id, 'record.json'), JSON.stringify({ ...source, id, title: '同名会话', updatedAt }));
      }

      let output = '';
      const chooser = startCLI({ cwd, userDir, conversationId: sourceId, pty: true, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      chooser.send('/resume\n');
      await waitForOutput(() => output, '同名会话', 1);
      const initialScreen = output.slice(output.lastIndexOf('\u001b[2J'));
      expect(initialScreen).toContain('duplicate-title-first');
      expect(initialScreen).toContain('duplicate-title-second');
      chooser.send('\u001b[B\r');
      await waitForOutput(() => output, '已继续会话：duplicate-title-second', 1);
      chooser.end('/exit\n');
      expect((await chooser.done).code).toBe(0);
      expect(model.requests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('closes the chooser when terminal input ends', async () => {
    const cwd = await directory('chooser-close-cwd');
    const userDir = await directory('chooser-close-user');
    const model = await startLocalOpenAIModel(() => ({ content: '未预期的请求' }));
    try {
      await configure(cwd, model.baseURL);
      const create = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '/exit\n' });
      expect((await create.done).code).toBe(0);

      let output = '';
      const chooser = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, pty: true }, (text) => { output = text; });
      chooser.send('/resume\n');
      await waitForOutput(() => output, '当前工作区会话', 1);
      chooser.end();

      const result = await chooser.done;
      expect(result.code).toBe(0);
      expect(model.requests).toHaveLength(0);
    } finally {
      await model.close();
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

  it.skipIf(process.platform === 'win32')('does not invent a tool result when Ctrl+C interrupts a running tool', async () => {
    const cwd = await directory('recovery-cancelled-tool-cwd');
    const userDir = await directory('recovery-cancelled-tool-user');
    const model = await startLocalOpenAIModel(() => ({ calls: [{ id: 'cancelled-tool-call', type: 'function', function: {
      name: 'Bash', arguments: JSON.stringify({ command: 'sleep 5' }),
    } }] }));
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const interrupted = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      interrupted.send('运行可取消工具\n');
      await waitForOutput(() => output, '[工具] Bash：开始', 1);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('中断会话尚未持久化');
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      interrupted.child.kill('SIGINT');
      await interrupted.done;

      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        transcript: Array<{ role: string; content: unknown }>;
        rounds: Array<{ status: string }>;
      };
      expect(record.rounds.map(({ status }) => status)).toEqual(['cancelled']);
      expect(JSON.stringify(record.transcript)).toContain('cancelled-tool-call');
      expect(record.transcript.some(({ role, content }) => role === 'tool' && JSON.stringify(content).includes('cancelled-tool-call'))).toBe(false);
    } finally {
      await model.close();
    }
  });

  it.skipIf(process.platform === 'win32')('recovers saved context after SIGTERM without replaying an unfinished tool call', async () => {
    const cwd = await directory('recovery-sigterm-cwd');
    const userDir = await directory('recovery-sigterm-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'sigterm-tool-call', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'sleep 5' }),
      } }] }
      : { content: '已从中断会话恢复。' });
    try {
      await configure(cwd, model.baseURL);
      let output = '';
      const interrupted = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (text) => { output = text; });
      interrupted.send('SIGTERM 前已保存的消息\n');
      await waitForOutput(() => output, '[工具] Bash：开始', 1);
      const [id] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      if (!id) throw new Error('中断会话尚未持久化');
      const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', id, 'record.json');
      interrupted.child.kill('SIGTERM');
      await interrupted.done;

      const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
        transcript: Array<{ role: string; content: unknown }>;
        rounds: Array<{ status: string; error?: { code: string; message: string } }>;
      };
      expect(record.rounds.map(({ status }) => status)).toEqual(['cancelled']);
      expect(JSON.stringify(record.transcript)).toContain('SIGTERM 前已保存的消息');
      expect(record.rounds[0]?.error?.code).toBe('CANCELLED');
      expect(record.transcript.some(({ role, content }) => role === 'tool' && JSON.stringify(content).includes('sigterm-tool-call'))).toBe(false);

      const resumed = startCLI({ cwd, userDir, conversationId: id, env: { TEST_MODEL_API_KEY: secret } });
      resumed.end('继续对话\n/exit\n');
      expect((await resumed.done).code).toBe(0);
      expect(JSON.stringify(model.requests[1])).toContain('SIGTERM 前已保存的消息');
      expect(JSON.stringify(model.requests[1])).not.toContain('sigterm-tool-call');
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
