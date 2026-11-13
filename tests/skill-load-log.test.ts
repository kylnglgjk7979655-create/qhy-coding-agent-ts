import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const secret = 'skill-load-log-test-key';

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

interface StoredSession {
  skillLoads?: string[];
  transcript: Array<{ role: string; content: unknown }>;
}

describe('Skill 加载顺序记录', () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function directory(name: string): Promise<string> {
    const root = await tempDir(`qhy-${name}-`);
    roots.push(root);
    return root;
  }

  async function configure(cwd: string, baseURL: string): Promise<void> {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      timeoutMs: 3000, maxSteps: 10,
      approval: { mode: 'auto' },
      permissions: { allow: ['Read', 'Write', 'Glob', 'Grep', 'Agent', 'RuntimeInfo'] },
    }));
  }

  async function writeSkill(root: string, name: string, body: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 说明\n---\n\n${body}\n`);
  }

  async function sessionRecord(userDir: string, conversationId?: string): Promise<StoredSession> {
    const sessions = join(userDir, '.qhy-coding-agents', 'sessions');
    const id = conversationId ?? (await readdir(sessions))[0]!;
    const path = join(sessions, id, 'record.json');
    return JSON.parse(await readFile(path, 'utf8')) as StoredSession;
  }

  async function writeSessionRecord(userDir: string, conversationId: string, record: StoredSession): Promise<void> {
    await writeFile(join(userDir, '.qhy-coding-agents', 'sessions', conversationId, 'record.json'), JSON.stringify(record));
  }

  it('按加载顺序记录规范名称，同一 Skill 重复加载只保留最近一次位置', async () => {
    const cwd = await directory('skill-load-order-cwd');
    const userDir = await directory('skill-load-order-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        call('alpha-1', 'skill', { name: 'alpha' }),
        call('beta-1', 'skill', { name: 'beta' }),
        call('alpha-2', 'skill', { name: 'alpha' }),
      ] }
      : { content: '已加载多个 Skill。' });
    try {
      await configure(cwd, model.baseURL);
      const skills = join(userDir, '.qhy-coding-agents', 'skills');
      await writeSkill(skills, 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(skills, 'beta', 'BETA_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载多个 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);

      const record = await sessionRecord(userDir);
      expect(record.skillLoads).toEqual(['beta', 'alpha']);
    } finally {
      await model.close();
    }
  });

  it('跨进程续聊保留已有顺序并追加新加载', async () => {
    const cwd = await directory('skill-load-resume-cwd');
    const userDir = await directory('skill-load-resume-user');
    const model = await startLocalOpenAIModel((request) => {
      const serialized = JSON.stringify(request.messages);
      const lastUser = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).at(-1) ?? '';
      if (lastUser === '加载 Alpha' && !serialized.includes('ALPHA_BODY_MARKER')) {
        return { calls: [call('load-alpha', 'skill', { name: 'alpha' })] };
      }
      if (lastUser === '加载 Beta' && !serialized.includes('BETA_BODY_MARKER')) {
        return { calls: [call('load-beta', 'skill', { name: 'beta' })] };
      }
      return { content: '已完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const skills = join(userDir, '.qhy-coding-agents', 'skills');
      await writeSkill(skills, 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(skills, 'beta', 'BETA_BODY_MARKER');

      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Alpha\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const firstRecord = await sessionRecord(userDir);
      expect(firstRecord.skillLoads).toEqual(['alpha']);

      const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
      const resumed = startCLI({ cwd, userDir, conversationId: conversationId!, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Beta\n/exit\n' });
      expect((await resumed.done).code).toBe(0);

      const record = await sessionRecord(userDir, conversationId);
      expect(record.skillLoads).toEqual(['alpha', 'beta']);
      expect(JSON.stringify(record.transcript)).toContain('加载 Alpha');
      expect(JSON.stringify(record.transcript)).toContain('加载 Beta');
    } finally {
      await model.close();
    }
  });

  it('缺少加载顺序字段的旧会话记录仍可加载并继续记录', async () => {
    const cwd = await directory('skill-load-legacy-cwd');
    const userDir = await directory('skill-load-legacy-user');
    const model = await startLocalOpenAIModel((request) => {
      const serialized = JSON.stringify(request.messages);
      const lastUser = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).at(-1) ?? '';
      if (lastUser === '加载 Alpha' && !serialized.includes('ALPHA_BODY_MARKER')) {
        return { calls: [call('legacy-alpha', 'skill', { name: 'alpha' })] };
      }
      if (lastUser === '加载 Beta' && !serialized.includes('BETA_BODY_MARKER')) {
        return { calls: [call('legacy-beta', 'skill', { name: 'beta' })] };
      }
      return { content: '旧记录继续完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      const skills = join(userDir, '.qhy-coding-agents', 'skills');
      await writeSkill(skills, 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(skills, 'beta', 'BETA_BODY_MARKER');

      const first = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Alpha\n/exit\n' });
      expect((await first.done).code).toBe(0);
      const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));

      const record = await sessionRecord(userDir, conversationId);
      expect(record.skillLoads).toEqual(['alpha']);
      delete record.skillLoads;
      await writeSessionRecord(userDir, conversationId!, record);

      const resumed = startCLI({ cwd, userDir, conversationId: conversationId!, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Beta\n/exit\n' });
      expect((await resumed.done).code).toBe(0);

      const afterResume = await sessionRecord(userDir, conversationId);
      expect(afterResume.skillLoads).toEqual(['beta']);
      expect(JSON.stringify(afterResume.transcript)).toContain('加载 Alpha');
      expect(JSON.stringify(afterResume.transcript)).toContain('加载 Beta');
    } finally {
      await model.close();
    }
  });
});