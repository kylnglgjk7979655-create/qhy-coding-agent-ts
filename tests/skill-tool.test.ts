import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest, FixtureToolCall } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const secret = 'skill-tool-test-key';

interface ToolResult {
  is_error: boolean;
  output?: { name?: string };
  error?: { code: string; message: string };
}

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

function toolResults(request: FixtureRequest | undefined): ToolResult[] {
  const messages = request?.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string }>;
  return (messages ?? []).map(({ content }) => JSON.parse(content) as ToolResult);
}

describe('Skill 工具', () => {
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

  async function writeSkill(root: string, name: string, frontmatter: string, body: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  }

  it('主 Agent 可按规范名称、显示名称或别名调用 Skill，工具结果不含正文', async () => {
    const cwd = await directory('skill-tool-cwd');
    const userDir = await directory('skill-tool-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        call('by-name', 'skill', { name: 'alpha' }),
        call('by-display', 'skill', { name: '阿尔法' }),
        call('by-alias', 'skill', { name: 'a' }),
        call('by-alias-cn', 'skill', { name: '别名' }),
      ] }
      : { content: 'Skill 调用完成。' });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndisplay_name: 阿尔法\naliases: [a, 别名]\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(model.requests[0]!.tools.map(({ function: fn }) => fn.name)).toContain('skill');
      const results = toolResults(model.requests[1]);
      expect(results.map(({ is_error }) => is_error)).toEqual([false, false, false, false]);
      expect(results.map(({ output }) => output)).toEqual([
        { name: 'alpha' }, { name: 'alpha' }, { name: 'alpha' }, { name: 'alpha' },
      ]);
      expect(JSON.stringify(results)).not.toContain('ALPHA_BODY_MARKER');
      expect(model.approvalRequests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });

  it('未登记的 Skill 名称与模糊前缀都返回 Unknown skill 失败', async () => {
    const cwd = await directory('skill-tool-unknown-cwd');
    const userDir = await directory('skill-tool-unknown-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        call('missing', 'skill', { name: 'missing' }),
        call('partial', 'skill', { name: 'alp' }),
      ] }
      : { content: '已处理失败结果。' });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'alpha',
        'name: alpha\ndescription: 阿尔法说明', 'ALPHA_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '查找 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      const results = toolResults(model.requests[1]);
      expect(results.map(({ is_error }) => is_error)).toEqual([true, true]);
      expect(results.map(({ error }) => error)).toEqual([
        { code: 'TOOL_EXECUTION_ERROR', message: 'Unknown skill: missing' },
        { code: 'TOOL_EXECUTION_ERROR', message: 'Unknown skill: alp' },
      ]);
    } finally {
      await model.close();
    }
  });

  it('名称与别名冲突时按注册顺序命中第一个 Skill', async () => {
    const cwd = await directory('skill-tool-order-cwd');
    const userDir = await directory('skill-tool-order-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [call('conflict', 'skill', { name: 'first-skill' })] }
      : { content: '已加载第一个 Skill。' });
    try {
      await configure(cwd, model.baseURL);
      const skills = join(userDir, '.qhy-coding-agents', 'skills');
      await writeSkill(skills, 'first', 'name: first-skill\ndescription: 第一个', 'FIRST_BODY');
      await writeSkill(skills, 'second', 'name: second-skill\naliases: [first-skill]\ndescription: 第二个', 'SECOND_BODY');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载冲突名称\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(toolResults(model.requests[1])).toEqual([{ is_error: false, output: { name: 'first-skill' } }]);
    } finally {
      await model.close();
    }
  });

  it('主 Agent、Explore 与 general-purpose 子 Agent 都能调用 Skill 且不产生审批', async () => {
    const cwd = await directory('skill-tool-agents-cwd');
    const userDir = await directory('skill-tool-agents-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [call('explore', 'agent', {
        description: '调查', prompt: '检查项目', subagent_type: 'Explore',
      })] };
      if (index === 2) return { calls: [call('explore-skill', 'skill', { name: 'shared-skill' })] };
      if (index === 3) return { content: '调查完成。' };
      if (index === 4) return { calls: [call('general', 'agent', {
        description: '处理', prompt: '处理任务',
      })] };
      if (index === 5) return { calls: [call('general-skill', 'skill', { name: 'shared-skill' })] };
      if (index === 6) return { content: '子任务完成。' };
      return { content: '全部完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'shared',
        'name: shared-skill\ndescription: 共享说明', 'SHARED_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '开始\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(7);
      for (const index of [0, 1, 4]) {
        expect(model.requests[index]!.tools.map(({ function: fn }) => fn.name)).toContain('skill');
      }
      expect(toolResults(model.requests[2])).toEqual([{ is_error: false, output: { name: 'shared-skill' } }]);
      expect(toolResults(model.requests[5])).toEqual([{ is_error: false, output: { name: 'shared-skill' } }]);
      expect(JSON.stringify(model.requests[2])).not.toContain('SHARED_BODY_MARKER');
      expect(JSON.stringify(model.requests[5])).not.toContain('SHARED_BODY_MARKER');
      expect(model.approvalRequests).toHaveLength(0);
    } finally {
      await model.close();
    }
  });
});