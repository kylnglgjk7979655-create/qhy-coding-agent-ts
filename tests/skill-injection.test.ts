import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { isSkillInjectionMessage } from '../src/services/skills/skill-injection.js';
import type { SkillRecord } from '../src/services/skills/skill-registry.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { readStoredSession, writeLegacySession } from './helpers/session-store.js';
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
    const record = await readStoredSession(userDir, id) as {
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

  it('全历史压缩后当前轮用户消息与工具往返进入摘要，Skill 正文按恢复消息保留', async () => {
    const cwd = await directory('skill-inject-compact-cwd');
    const userDir = await directory('skill-inject-compact-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('load', 'skill', { name: 'alpha' })] };
      if (index === 2) return { calls: [call('read', 'read_file', { path: 'large.txt' })] };
      return { content: '压缩后完成。' };
    });
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 23000, answerReserveTokens: 2000, maxOutputTokens: 1000, triggerRatio: 0.5, targetRatio: 0.45, keepRecentTurns: 0,
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

      // 全历史压缩覆盖当前轮的用户消息与已完成工具往返。
      const source = JSON.parse(model.summaryRequests[0]!.messages[1]!.content) as Array<{ role: string; content: string }>;
      expect(JSON.stringify(source)).toContain('当前需求_MARKER');

      const compacted = model.requests.at(-1)!;
      expect(JSON.stringify(compacted)).not.toContain('当前需求_MARKER');
      expect(JSON.stringify(compacted)).toContain('ALPHA_BODY_MARKER');
      // 工具往返已被摘要替换；注入正文作为恢复消息排在摘要包装之后。
      expect(compacted.messages.filter(({ role }) => role === 'tool')).toEqual([]);
      const injectionIndex = compacted.messages.findIndex(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      expect(injectionIndex).toBeGreaterThan(0);
      expect(compacted.messages[injectionIndex - 1]!.content).toContain('[对话摘要]');
    } finally {
      await model.close();
    }
  });

  it('旧历史中以 Skill: 开头的普通多行用户消息不被识别为注入', () => {
    const alpha: SkillRecord = {
      type: 'prompt', name: 'alpha', displayName: 'alpha', aliases: [], description: '阿尔法说明',
      getPromptForCommand: () => 'ALPHA_BODY_MARKER',
    };
    const catalogue = [alpha];
    // 普通用户消息即使以展示标头开头，只要名称未精确命中注册 Skill 就不视为注入。
    const ordinary: ModelMessage = { role: 'user', content: 'Skill: 这是用户普通说明\nUSER_NOTE_MARKER' };
    expect(isSkillInjectionMessage(ordinary, catalogue)).toBe(false);
    expect(isSkillInjectionMessage({ role: 'user', content: 'Skill: unknown\nX' }, catalogue)).toBe(false);
    expect(isSkillInjectionMessage({ role: 'user', content: 'Skill: alpha 额外说明\nX' }, catalogue)).toBe(false);
    // 持久标记始终视为注入；旧记录回退为标头名称精确匹配已注册 Skill。
    expect(isSkillInjectionMessage({
      role: 'user', content: 'Skill: alpha\nALPHA_BODY_MARKER', providerOptions: { qhy: { skillInjection: true } },
    }, catalogue)).toBe(true);
    expect(isSkillInjectionMessage({ role: 'user', content: 'Skill: alpha\nALPHA_BODY_MARKER' }, catalogue)).toBe(true);
  });

  it.each([false, true])('跨进程后真实 Skill 注入正文仍在全历史压缩后恢复（旧记录：%s）', async (legacy) => {
    const cwd = await directory('skill-boundary-resume-cwd');
    const userDir = await directory('skill-boundary-resume-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('load', 'skill', { name: 'alpha' })] };
      return { content: index === 2 ? '旧'.repeat(4000) : '续聊完成。' };
    });
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 28400, answerReserveTokens: 2000, maxOutputTokens: 1000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 1,
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
        const record = await readStoredSession(userDir, 'boundary');
        // 模拟来源标记引入前保存的会话，保留真实工具调用与结果。
        const oldRecord = JSON.parse(JSON.stringify(record, (key, value) => key === 'providerOptions' ? undefined : value));
        await writeLegacySession(userDir, oldRecord as Parameters<typeof writeLegacySession>[1]);
      }
      const resumed = startCLI({ cwd, userDir, conversationId: 'boundary', input: `${'新'.repeat(2000)}\n/exit\n`, env: { TEST_MODEL_API_KEY: secret } });
      const result = await resumed.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(model.summaryRequests).toHaveLength(1);
      // 全历史压缩把原加载轮次一并摘要；工具往返不再保留，但正文按最近加载记录恢复。
      expect(JSON.stringify(model.summaryRequests[0])).toContain('LOAD_ROUND_MARKER');
      const request = model.requests.at(-1)!;
      expect(JSON.stringify(request)).not.toContain('LOAD_ROUND_MARKER');
      expect(request.messages.some(({ role }) => role === 'tool')).toBe(false);
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
        capacityTokens: 19250, answerReserveTokens: 1000, maxOutputTokens: 1000, triggerRatio: 0.75, targetRatio: 0.5, keepRecentTurns: 0,
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