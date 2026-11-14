import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const secret = 'skill-restore-test-key';
const summaryText = '目标：恢复 Skill 正文；决策：按最近加载顺序；约束：只改有效历史；关键结果：压缩已完成；未完成事项：继续处理。';

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface StoredSession {
  skillLoads?: string[];
  transcript: Array<{ role: string; content: unknown }>;
  effectiveHistory: Array<{ role: string; content: unknown }>;
  summaries: Array<{ text: string; coversThrough: number; restoredMessages?: number }>;
}

describe('压缩后恢复 Skill 正文', () => {
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

  async function configure(cwd: string, baseURL: string, context: Record<string, unknown>): Promise<void> {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
      timeoutMs: 5000, maxSteps: 10,
      approval: { mode: 'auto' },
      permissions: { allow: ['Read', 'Write', 'Glob', 'Grep', 'Agent', 'RuntimeInfo'] },
      context,
    }));
  }

  async function writeSkill(root: string, name: string, body: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 说明\n---\n\n${body}\n`);
  }

  async function writeLegacy(cwd: string, conversationId: string, messages: unknown[]): Promise<void> {
    await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'conversations', `${conversationId}.json`), JSON.stringify(messages));
  }

  async function sessionRecord(userDir: string): Promise<StoredSession> {
    const sessions = join(userDir, '.qhy-coding-agents', 'sessions');
    const id = (await readdir(sessions))[0]!;
    return JSON.parse(await readFile(join(sessions, id, 'record.json'), 'utf8')) as StoredSession;
  }

  function injectionNames(messages: Array<{ role: string; content: unknown }>): string[] {
    return messages
      .filter(({ role, content }) => role === 'user' && typeof content === 'string' && content.startsWith('Skill: '))
      .map(({ content }) => (content as string).slice('Skill: '.length).split('\n', 1)[0]!);
  }

  it('压缩后按最近加载顺序恢复被摘要移除的正文，并写入有效历史而不写入 transcript', async () => {
    const cwd = await directory('skill-restore-cwd');
    const userDir = await directory('skill-restore-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('load-alpha', 'skill', { name: 'alpha' }), call('load-beta', 'skill', { name: 'beta' })] }
      : { content: index === 2 ? '已加载两个 Skill。' : '压缩后完成。' }, undefined, () => ({ content: summaryText }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 0,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'beta', 'BETA_BODY_MARKER');
      await writeLegacy(cwd, 'skill-restore', [
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(7000) },
      ]);

      const secondPrompt = '需求'.repeat(4000);
      const cli = startCLI({
        cwd, userDir, conversationId: 'skill-restore', env: { TEST_MODEL_API_KEY: secret },
        input: `加载两个 Skill\n${secondPrompt}\n/exit\n`,
      });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(result.code).toBe(0);
      expect(model.summaryRequests).toHaveLength(1);
      expect(model.requests).toHaveLength(3);

      // 第一轮注入成功，第二轮压缩移除旧原文后恢复正文。
      expect(injectionNames(model.requests[1]!.messages)).toEqual(['alpha', 'beta']);
      const compacted = model.requests[2]!;
      const serialized = JSON.stringify(compacted);
      expect(serialized).toContain(summaryText);
      expect(serialized).not.toContain('旧原文_MARKER');
      expect(serialized).toContain('ALPHA_BODY_MARKER');
      expect(serialized).toContain('BETA_BODY_MARKER');
      // 最近加载的 beta 排在 alpha 之前，且都只恢复一次。
      expect(injectionNames(compacted.messages)).toEqual(['beta', 'alpha']);
      expect(count(serialized, 'ALPHA_BODY_MARKER')).toBe(1);
      expect(count(serialized, 'BETA_BODY_MARKER')).toBe(1);
      expect(compacted.messages.at(-1)?.content).toBe(secondPrompt);

      // 系统指令与工具策略不随恢复变化。
      expect(compacted.messages[0]).toEqual(model.requests[0]!.messages[0]);
      expect(compacted.tools).toEqual(model.requests[0]!.tools);

      // 恢复只进入有效历史，transcript 仍只有原始注入各一次。
      const record = await sessionRecord(userDir);
      const transcript = JSON.stringify(record.transcript);
      const effective = JSON.stringify(record.effectiveHistory);
      expect(count(transcript, 'ALPHA_BODY_MARKER')).toBe(1);
      expect(count(transcript, 'BETA_BODY_MARKER')).toBe(1);
      expect(effective).toContain('ALPHA_BODY_MARKER');
      expect(effective).toContain('BETA_BODY_MARKER');
      // 有效历史同样按最近加载顺序排列，跨进程续聊仍可直接使用。
      expect(injectionNames(record.effectiveHistory)).toEqual(['beta', 'alpha']);
      expect(record.summaries).toHaveLength(1);
      expect(record.summaries[0]!.text).toBe(summaryText);
    } finally {
      await model.close();
    }
  });

  it('正文仍在有效历史中的 Skill 不重复恢复', async () => {
    const cwd = await directory('skill-restore-keep-cwd');
    const userDir = await directory('skill-restore-keep-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('load-alpha', 'skill', { name: 'alpha' })] };
      if (index === 3) return { calls: [call('load-beta', 'skill', { name: 'beta' })] };
      return { content: `第 ${index} 步完成。` };
    }, undefined, () => ({ content: summaryText }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 1,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'beta', 'BETA_BODY_MARKER');
      await writeLegacy(cwd, 'skill-restore-keep', [
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(7000) },
      ]);

      const cli = startCLI({
        cwd, userDir, conversationId: 'skill-restore-keep', env: { TEST_MODEL_API_KEY: secret },
        input: `加载 Alpha\n加载 Beta\n${'需求'.repeat(4000)}\n/exit\n`,
      });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(result.code).toBe(0);
      expect(model.summaryRequests).toHaveLength(1);

      // 压缩只移除 alpha 所在轮次；beta 注入仍在保留历史中。
      const compacted = model.requests.at(-1)!;
      const serialized = JSON.stringify(compacted);
      expect(serialized).toContain(summaryText);
      expect(serialized).not.toContain('旧原文_MARKER');
      expect(injectionNames(compacted.messages)).toEqual(['alpha', 'beta']);
      expect(count(serialized, 'ALPHA_BODY_MARKER')).toBe(1);
      expect(count(serialized, 'BETA_BODY_MARKER')).toBe(1);
      // 恢复只补 alpha，beta 仍是保留历史中的原注入消息。
      const messages = compacted.messages;
      const alphaIndex = messages.findIndex(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      const betaIndex = messages.findIndex(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: beta'));
      const betaPromptIndex = messages.findIndex(({ role, content }) => role === 'user' && content === '加载 Beta');
      const summaryIndex = messages.findIndex(({ content }) => typeof content === 'string' && content.includes(summaryText));
      expect(alphaIndex).toBe(summaryIndex + 1);
      expect(betaIndex).toBeGreaterThan(betaPromptIndex);
    } finally {
      await model.close();
    }
  });

  it('多次压缩时摘要覆盖边界只按 transcript 消息计算', async () => {
    const cwd = await directory('skill-restore-boundary-cwd');
    const userDir = await directory('skill-restore-boundary-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('load-alpha', 'skill', { name: 'alpha' }), call('load-beta', 'skill', { name: 'beta' })] }
      : { content: `第 ${index} 步完成。` }, undefined, () => ({ content: summaryText }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 20000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 0,
      });
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha', 'ALPHA_BODY_MARKER');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'beta', 'BETA_BODY_MARKER');
      await writeLegacy(cwd, 'skill-restore-boundary', [
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(7000) },
      ]);

      const secondPrompt = '需求二'.repeat(3000);
      const thirdPrompt = '需求三'.repeat(3000);
      const cli = startCLI({
        cwd, userDir, conversationId: 'skill-restore-boundary', env: { TEST_MODEL_API_KEY: secret },
        input: `加载两个 Skill\n${secondPrompt}\n${thirdPrompt}\n继续\n/exit\n`,
      });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(result.code).toBe(0);
      expect(model.summaryRequests).toHaveLength(2);

      // 恢复正文不进 transcript，因此覆盖边界等于触发压缩的用户消息在 transcript 中的下标。
      const record = await sessionRecord(userDir);
      const indexOf = (prompt: string) => record.transcript
        .findIndex(({ role, content }) => role === 'user' && content === prompt);
      const secondIndex = indexOf(secondPrompt);
      const thirdIndex = indexOf(thirdPrompt);
      expect(secondIndex).toBeGreaterThan(0);
      expect(thirdIndex).toBeGreaterThan(secondIndex);
      expect(record.summaries.map(({ coversThrough }) => coversThrough)).toEqual([secondIndex, thirdIndex]);
      expect(record.summaries.map(({ restoredMessages }) => restoredMessages)).toEqual([2, 2]);
      expect(count(JSON.stringify(record.transcript), 'ALPHA_BODY_MARKER')).toBe(1);

      // 覆盖边界未越界，新进程仍能加载并续聊。
      const resumed = startCLI({
        cwd, userDir, conversationId: 'skill-restore-boundary', env: { TEST_MODEL_API_KEY: secret },
        input: '继续\n/exit\n',
      });
      const resumedResult = await resumed.done;
      expect(resumedResult.stdout + resumedResult.stderr).not.toContain('会话记录');
      expect(resumedResult.code).toBe(0);
    } finally {
      await model.close();
    }
  });

  it('单篇正文超过单篇预算时从开头保留并带省略标记', async () => {
    const cwd = await directory('skill-restore-budget-single-cwd');
    const userDir = await directory('skill-restore-budget-single-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('load-alpha', 'skill', { name: 'alpha' })] }
      : { content: '压缩后完成。' }, undefined, () => ({ content: summaryText }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 60000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 0,
      });
      const body = `ALPHA_HEAD_MARKER${'A'.repeat(20000)}ALPHA_TAIL_MARKER`;
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha', body);
      await writeLegacy(cwd, 'skill-restore-budget-single', [
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(20000) },
      ]);

      const cli = startCLI({
        cwd, userDir, conversationId: 'skill-restore-budget-single', env: { TEST_MODEL_API_KEY: secret },
        input: `加载 Alpha\n${'需求'.repeat(11000)}\n/exit\n`,
      });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(result.code).toBe(0);
      expect(model.summaryRequests).toHaveLength(1);
      expect(model.requests).toHaveLength(3);

      // 压缩前的注入保留完整正文，只有恢复时才按预算截断。
      expect(JSON.stringify(model.requests[1])).toContain('ALPHA_TAIL_MARKER');
      const compacted = model.requests.at(-1)!;
      const restored = compacted.messages.filter(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: alpha'));
      expect(restored).toHaveLength(1);
      const content = restored[0]!.content as string;
      // 标头保留，开头正文保留，结尾因预算省略。
      expect(content.startsWith('Skill: alpha\n')).toBe(true);
      expect(content).toContain('ALPHA_HEAD_MARKER');
      expect(content).not.toContain('ALPHA_TAIL_MARKER');
      expect(content).toContain('省略');
      expect(content.length).toBeLessThan(body.length);
      // 预算沿用上下文估算（按 3 字节约 1 token），截断结果不超过单篇上限。
      expect(Math.ceil(Buffer.byteLength(content, 'utf8') / 3)).toBeLessThanOrEqual(5000);
      expect(injectionNames(compacted.messages)).toEqual(['alpha']);
      expect((await sessionRecord(userDir)).summaries[0]!.restoredMessages).toBe(1);
    } finally {
      await model.close();
    }
  });

  it('合计超过恢复预算时最近加载优先，较早正文被截断或不再恢复', async () => {
    const cwd = await directory('skill-restore-budget-total-cwd');
    const userDir = await directory('skill-restore-budget-total-user');
    const names = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: names.map((name) => call(`load-${name}`, 'skill', { name })) }
      : { content: '压缩后完成。' }, undefined, () => ({ content: summaryText }));
    try {
      await configure(cwd, model.baseURL, {
        capacityTokens: 60000, answerReserveTokens: 2000, triggerRatio: 0.8, targetRatio: 0.7, keepRecentTurns: 0,
      });
      const skillsRoot = join(userDir, '.qhy-coding-agents', 'skills');
      for (const name of names) {
        await writeSkill(skillsRoot, name, `${name.toUpperCase()}_HEAD_${'X'.repeat(11980)}_TAIL`);
      }
      await writeLegacy(cwd, 'skill-restore-budget-total', [
        { role: 'user', content: '旧目标' },
        { role: 'assistant', content: '旧原文_MARKER' + '旧'.repeat(8000) },
      ]);

      const cli = startCLI({
        cwd, userDir, conversationId: 'skill-restore-budget-total', env: { TEST_MODEL_API_KEY: secret },
        input: `加载全部\n${'需求'.repeat(2500)}\n/exit\n`,
      });
      const result = await cli.done;
      expect(result.stdout + result.stderr).not.toContain('CONTEXT_ERROR');
      expect(result.code).toBe(0);
      expect(model.summaryRequests).toHaveLength(1);

      // 压缩前的注入保留全部正文。
      expect(count(JSON.stringify(model.requests[1]), '_TAIL')).toBe(names.length);

      const compacted = model.requests.at(-1)!;
      // 最近加载的 s8 优先占用预算，预算耗尽后不再恢复更早加载的 s1。
      expect(injectionNames(compacted.messages)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3', 's2']);
      const restored = compacted.messages.filter(({ role, content }) =>
        role === 'user' && typeof content === 'string' && content.startsWith('Skill: '));
      const byName = new Map(restored.map(({ content }) => {
        const text = (content as string).slice('Skill: '.length);
        return [text.split('\n', 1)[0]!, content as string];
      }));
      // 被截断的 s2 仍保留标头、开头正文与省略标记。
      const second = byName.get('s2')!;
      expect(second).toContain('S2_HEAD_');
      expect(second).not.toContain('_TAIL');
      expect(second).toContain('省略');
      expect(second.length).toBeLessThan(12000);
      // 省略标记计入预算，恢复总量不超过合计上限。
      const total = restored.reduce((sum, { content }) =>
        sum + Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf8') / 3) + 32, 0);
      expect(total).toBeLessThanOrEqual(25000);
      const record = await sessionRecord(userDir);
      expect(record.summaries[0]!.restoredMessages).toBe(restored.length);
      expect(record.skillLoads).toEqual(names);
    } finally {
      await model.close();
    }
  });
});