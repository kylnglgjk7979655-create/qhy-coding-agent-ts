import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const secret = 'skill-injection-test-key';

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function userMessages(request: FixtureRequest): string[] {
  return request.messages.filter(({ role }) => role === 'user').map(({ content }) => content);
}

describe('Skill 正文注入', () => {
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

  async function configure(cwd: string, baseURL: string, context?: Record<string, unknown>): Promise<void> {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      timeoutMs: 3000, maxSteps: 10,
      approval: { mode: 'auto' },
      permissions: { allow: ['Read', 'Write', 'Glob', 'Grep', 'Agent', 'RuntimeInfo'] },
      ...(context === undefined ? {} : { context }),
    }));
  }

  async function writeSkill(root: string, name: string, frontmatter: string, body: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  }

  async function sessionRecord(userDir: string, conversationId?: string) {
    const sessions = join(userDir, '.qhy-coding-agents', 'sessions');
    const id = conversationId ?? (await readdir(sessions))[0]!;
    const record = JSON.parse(await readFile(join(sessions, id, 'record.json'), 'utf8')) as {
      transcript: Array<{ role: string; content: unknown }>;
      effectiveHistory: Array<{ role: string; content: unknown }>;
    };
    return { id, record };
  }

  it('调用后的下一次请求在工具结果之后包含标头与正文，并进入 transcript 与有效历史', async () => {
    const cwd = await directory('skill-inject-cwd');
    const userDir = await directory('skill-inject-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('load', 'skill', { name: 'alpha' })] }
      : { content: '已按 Skill 完成。' });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);

      const followUp = model.requests[1]!.messages;
      const injection = followUp.at(-1)!;
      expect(injection.role).toBe('user');
      expect(injection.content.startsWith('Skill: alpha')).toBe(true);
      expect(injection.content).toContain('ALPHA_BODY_MARKER');
      // 工具结果与注入消息是两条独立消息，顺序分明。
      expect(followUp.at(-2)!.role).toBe('tool');
      expect(JSON.stringify(model.requests[0])).not.toContain('ALPHA_BODY_MARKER');
      // 注入不改变系统指令与工具策略。
      expect(followUp[0]).toEqual(model.requests[0]!.messages[0]);
      expect(model.requests[1]!.tools).toEqual(model.requests[0]!.tools);

      const { record } = await sessionRecord(userDir);
      const transcript = record.transcript;
      const toolIndex = transcript.findIndex(({ role }) => role === 'tool');
      const injectIndex = transcript.findIndex(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      expect(toolIndex).toBeGreaterThan(-1);
      expect(injectIndex).toBe(toolIndex + 1);
      expect(JSON.stringify(transcript)).toContain('ALPHA_BODY_MARKER');
      expect(JSON.stringify(record.effectiveHistory)).toContain('ALPHA_BODY_MARKER');

      // 续聊仍使用当时实际提供给模型的正文。
      const resumed = startCLI({ cwd, userDir, conversationId: (await sessionRecord(userDir)).id, input: '继续\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
      expect((await resumed.done).code).toBe(0);
      const resumedRequest = model.requests.at(-1)!;
      const resumedInjection = resumedRequest.messages.find(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      expect(resumedInjection).toBeDefined();
      expect(resumedInjection!.content).toContain('ALPHA_BODY_MARKER');
      expect(userMessages(resumedRequest)).toContain('继续');
    } finally {
      await model.close();
    }
  });

  it('注入消息不参与轮次切分，压缩时当前轮用户消息与工具往返不被摘要替换', async () => {
    const cwd = await directory('skill-inject-compact-cwd');
    const userDir = await directory('skill-inject-compact-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('load', 'skill', { name: 'alpha' })] };
      if (index === 2) return { calls: [call('read', 'read_file', { path: 'large.txt' })] };
      return { content: '压缩后完成。' };
    });
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.5, targetRatio: 0.45, keepRecentTurns: 0,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');
      await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
      await writeFile(join(cwd, '.agent', 'conversations', 'skill-inject.json'), JSON.stringify([
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(4000) },
      ]));
      await writeFile(join(cwd, 'large.txt'), '新'.repeat(4000));

      const cli = startCLI({ cwd, userDir, conversationId: 'skill-inject', input: '当前需求_MARKER\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(model.summaryRequests).toHaveLength(1);

      // 摘要只覆盖较早轮次，不包含当前轮的用户消息。
      const source = JSON.parse(model.summaryRequests[0]!.messages[1]!.content) as Array<{ role: string; content: string }>;
      expect(JSON.stringify(source)).not.toContain('当前需求_MARKER');

      const compacted = model.requests.at(-1)!;
      expect(JSON.stringify(compacted)).toContain('当前需求_MARKER');
      expect(JSON.stringify(compacted)).toContain('ALPHA_BODY_MARKER');
      // 当前轮的工具往返与注入消息一起保留，注入消息仍排在工具结果之后。
      const injectionIndex = compacted.messages.findIndex(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      expect(injectionIndex).toBeGreaterThan(0);
      expect(compacted.messages[injectionIndex - 1]!.role).toBe('tool');
    } finally {
      await model.close();
    }
  });

  it('旧历史中以 Skill: 开头的普通多行用户消息仍划分轮次并保留最近一轮', async () => {
    const cwd = await directory('skill-ordinary-cwd');
    const userDir = await directory('skill-ordinary-user');
    const model = await startLocalOpenAIModel(() => ({ content: '继续完成。' }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 1,
      });
      await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
      const note = 'Skill: 这是用户普通说明\nUSER_NOTE_MARKER';
      await writeFile(join(cwd, '.agent', 'conversations', 'ordinary.json'), JSON.stringify([
        { role: 'user', content: 'OLD_GOAL' },
        { role: 'assistant', content: 'OLD_MARKER' + '旧'.repeat(17000) },
        { role: 'user', content: note },
        { role: 'assistant', content: 'NOTE_REPLY' },
      ]));

      const cli = startCLI({ cwd, userDir, conversationId: 'ordinary', input: 'CURRENT\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(model.summaryRequests).toHaveLength(1);
      expect(model.requests).toHaveLength(1);
      expect(JSON.stringify(model.summaryRequests[0])).toContain('OLD_MARKER');
      expect(JSON.stringify(model.summaryRequests[0])).not.toContain('USER_NOTE_MARKER');
      expect(userMessages(model.requests[0]!)).toEqual([note, 'CURRENT']);
      const { record } = await sessionRecord(userDir, 'ordinary');
      expect(JSON.stringify(record.transcript)).toContain('OLD_MARKER');
      expect(JSON.stringify(record.effectiveHistory)).not.toContain('OLD_MARKER');
    } finally {
      await model.close();
    }
  });

  it.each([false, true])('跨进程后真实 Skill 注入仍属于原用户轮次（旧记录：%s）', async (legacy) => {
    const cwd = await directory('skill-boundary-resume-cwd');
    const userDir = await directory('skill-boundary-resume-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('load', 'skill', { name: 'alpha' })] };
      return { content: index === 2 ? '旧'.repeat(4000) : '续聊完成。' };
    });
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 1,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');
      await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
      await writeFile(join(cwd, '.agent', 'conversations', 'boundary.json'), JSON.stringify([
        { role: 'user', content: 'OLD_GOAL' },
        { role: 'assistant', content: 'OLD_MARKER' + '旧'.repeat(9000) },
      ]));
      const first = startCLI({ cwd, userDir, conversationId: 'boundary', input: 'LOAD_ROUND_MARKER\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
      expect((await first.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(model.summaryRequests).toHaveLength(0);
      if (legacy) {
        const path = join(userDir, '.qhy-coding-agents', 'sessions', 'boundary', 'record.json');
        const record = JSON.parse(await readFile(path, 'utf8'));
        // 模拟来源标记引入前保存的会话，保留真实工具调用与结果。
        const oldRecord = JSON.stringify(record, (key, value) => key === 'providerOptions' ? undefined : value);
        await writeFile(path, oldRecord);
      }
      const resumed = startCLI({ cwd, userDir, conversationId: 'boundary', input: `${'新'.repeat(2000)}\n/exit\n`, env: { TEST_MODEL_API_KEY: secret } });
      const result = await resumed.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(model.summaryRequests).toHaveLength(1);
      expect(JSON.stringify(model.summaryRequests[0])).not.toContain('LOAD_ROUND_MARKER');
      const request = model.requests.at(-1)!;
      expect(JSON.stringify(request)).toContain('LOAD_ROUND_MARKER');
      expect(request.messages.some(({ role }) => role === 'tool')).toBe(true);
      expect(JSON.stringify(request)).toContain('ALPHA_BODY_MARKER');
    } finally {
      await model.close();
    }
  });

  it('本轮第一次请求就发生压缩时，工具结果之后仍注入正文', async () => {
    const cwd = await directory('skill-inject-early-cwd');
    const userDir = await directory('skill-inject-early-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('load', 'skill', { name: 'alpha' })] }
      : { content: '完成后答复。' });
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 8000, answerReserveTokens: 1000, triggerRatio: 0.75, targetRatio: 0.5, keepRecentTurns: 0,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');
      await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
      await writeFile(join(cwd, '.agent', 'conversations', 'skill-inject-early.json'), JSON.stringify([
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(4000) },
      ]));

      const cli = startCLI({ cwd, userDir, conversationId: 'skill-inject-early', input: '当前需求_MARKER\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      // 第一次请求前已压缩，注入发生在压缩后的下一请求。
      expect(model.summaryRequests).toHaveLength(1);
      expect(model.requests).toHaveLength(2);
      const followUp = model.requests[1]!.messages;
      const injection = followUp.at(-1)!;
      expect(injection.role).toBe('user');
      expect(injection.content.startsWith('Skill: alpha')).toBe(true);
      expect(injection.content).toContain('ALPHA_BODY_MARKER');
      expect(followUp.at(-2)!.role).toBe('tool');

      const { record } = await sessionRecord(userDir);
      expect(JSON.stringify(record.effectiveHistory)).toContain('ALPHA_BODY_MARKER');
    } finally {
      await model.close();
    }
  });
});