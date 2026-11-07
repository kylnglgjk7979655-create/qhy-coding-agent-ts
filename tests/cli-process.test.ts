import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      const record = JSON.parse(stored) as { workspace: string; transcript: Array<{ content: unknown }>; rounds: Array<{ status: string }>; config: { apiKeyEnv: string } };
      expect(record.workspace).toBe(firstCwd);
      expect(JSON.stringify(record.transcript)).toContain('第二条');
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
