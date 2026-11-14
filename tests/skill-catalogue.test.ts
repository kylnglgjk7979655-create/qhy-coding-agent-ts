import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const secret = 'skill-catalogue-test-key';

describe('Skill 注册与清单', () => {
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

  function systemText(request: { messages: Array<{ role: string; content: string }> }): string {
    return request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
  }

  it('系统指令包含项目与全局 Skill 的名称和说明，但不包含正文', async () => {
    const cwd = await directory('skill-catalogue-cwd');
    const userDir = await directory('skill-catalogue-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(cwd, '.qhy-coding-agent', 'skills'), 'project-skill', 'name: project-skill\ndescription: 项目 Skill 说明', 'PROJECT_BODY_MARKER');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'global-skill', 'name: global-skill\ndescription: 全局 Skill 说明', 'GLOBAL_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '查看 Skill 清单\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(1);
      const instructions = systemText(model.requests[0]!);
      expect(instructions).toContain('project-skill');
      expect(instructions).toContain('项目 Skill 说明');
      expect(instructions).toContain('global-skill');
      expect(instructions).toContain('全局 Skill 说明');
      expect(instructions).not.toContain('PROJECT_BODY_MARKER');
      expect(instructions).not.toContain('GLOBAL_BODY_MARKER');
    } finally {
      await model.close();
    }
  });

  it('同名 Skill 按项目在前、各来源内按名称排序', async () => {
    const cwd = await directory('skill-catalogue-order-cwd');
    const userDir = await directory('skill-catalogue-order-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      const projectSkills = join(cwd, '.qhy-coding-agent', 'skills');
      const globalSkills = join(userDir, '.qhy-coding-agents', 'skills');
      await writeSkill(projectSkills, 'zeta', 'name: zeta\ndescription: 项目 Z', '项目 Z 正文');
      await writeSkill(projectSkills, 'alpha', 'name: alpha\ndescription: 项目阿尔法', '项目阿尔法正文');
      await writeSkill(globalSkills, 'beta', 'name: beta\ndescription: 全局 B', '全局 B 正文');
      await writeSkill(globalSkills, 'alpha', 'name: alpha\ndescription: 全局阿尔法', '全局阿尔法正文');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '查看顺序\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(1);
      const instructions = systemText(model.requests[0]!);
      const positions = ['项目阿尔法', '项目 Z', '全局阿尔法', '全局 B'].map((text) => instructions.indexOf(text));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      expect(instructions.match(/alpha/g)).toHaveLength(2);
    } finally {
      await model.close();
    }
  });

  it('无法解析或缺少说明的 Skill 目录被跳过且 CLI 正常完成一轮对话', async () => {
    const cwd = await directory('skill-catalogue-invalid-cwd');
    const userDir = await directory('skill-catalogue-invalid-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      const projectSkills = join(cwd, '.qhy-coding-agent', 'skills');
      await writeSkill(projectSkills, 'valid', 'name: valid\ndescription: 有效说明', '有效正文');
      await writeSkill(projectSkills, 'missing-description', 'name: missing-description', '缺少说明');
      await writeSkill(projectSkills, 'missing-name', 'description: 缺少名称', '缺少名称');
      await mkdir(join(projectSkills, 'broken'), { recursive: true });
      await writeFile(join(projectSkills, 'broken', 'SKILL.md'), '没有 frontmatter 的正文');
      await writeFile(join(projectSkills, 'not-a-directory'), '不是目录');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '检查无效 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(1);
      const instructions = systemText(model.requests[0]!);
      expect(instructions).toContain('valid');
      expect(instructions).toContain('有效说明');
      expect(instructions).not.toContain('missing-description');
      expect(instructions).not.toContain('missing-name');
      expect(instructions).not.toContain('没有 frontmatter 的正文');
    } finally {
      await model.close();
    }
  });

  it('注册后修改 Skill 文件，本轮请求仍使用注册时读入的内容', async () => {
    const cwd = await directory('skill-catalogue-snapshot-cwd');
    const userDir = await directory('skill-catalogue-snapshot-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      const skillFile = join(userDir, '.qhy-coding-agents', 'skills', 'snapshot', 'SKILL.md');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'snapshot', 'name: snapshot\ndescription: 初始说明', '初始正文');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } });
      cli.send('第一轮\n');
      await waitForRequests(model.requests, 1);
      await writeFile(skillFile, '---\nname: snapshot\ndescription: 修改说明\n---\n\n修改正文\n');
      cli.send('第二轮\n');
      await waitForRequests(model.requests, 2);
      cli.end('/exit\n');
      expect((await cli.done).code).toBe(0);

      expect(systemText(model.requests[0]!)).toContain('初始说明');
      expect(systemText(model.requests[1]!)).toContain('初始说明');
      expect(systemText(model.requests[1]!)).not.toContain('修改说明');
    } finally {
      await model.close();
    }
  });

  it('注册后修改 Skill 文件，调用时仍返回注册时读入的正文', async () => {
    const cwd = await directory('skill-catalogue-body-cwd');
    const userDir = await directory('skill-catalogue-body-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'load', type: 'function', function: {
        name: 'skill', arguments: JSON.stringify({ name: 'snapshot' }),
      } }] }
      : { content: '已完成。' });
    try {
      await configure(cwd, model.baseURL);
      const skillFile = join(userDir, '.qhy-coding-agents', 'skills', 'snapshot', 'SKILL.md');
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'snapshot',
        'name: snapshot\ndescription: 初始说明', '初始正文_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } });
      cli.send('第一轮\n');
      await waitForRequests(model.requests, 1);
      await writeFile(skillFile, '---\nname: snapshot\ndescription: 修改说明\n---\n\n修改正文_MARKER\n');
      cli.send('加载 snapshot\n');
      await waitForRequests(model.requests, 3);
      cli.end('/exit\n');
      expect((await cli.done).code).toBe(0);

      expect(JSON.stringify(model.requests[2])).toContain('Skill: snapshot');
      expect(JSON.stringify(model.requests[2])).toContain('初始正文_MARKER');
      expect(JSON.stringify(model.requests[2])).not.toContain('修改正文_MARKER');
    } finally {
      await model.close();
    }
  });

  it('主 Agent、Explore 与 general-purpose 子 Agent 都收到同一份清单', async () => {
    const cwd = await directory('skill-catalogue-agents-cwd');
    const userDir = await directory('skill-catalogue-agents-user');
    const model = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'explore-call', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查项目', subagent_type: 'Explore' }),
      } }] };
      if (index === 2) return { content: '调查完成。' };
      if (index === 3) return { calls: [{ id: 'general-call', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '处理', prompt: '处理任务' }),
      } }] };
      if (index === 4) return { content: '子任务完成。' };
      return { content: '全部完成。' };
    });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(userDir, '.qhy-coding-agents', 'skills'), 'shared-skill', 'name: shared-skill\ndescription: 共享说明', 'SHARED_BODY_MARKER');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '开始\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      await waitForRequests(model.requests, 5);
      const main = systemText(model.requests[0]!);
      const explore = systemText(model.requests[1]!);
      const general = systemText(model.requests[3]!);
      for (const instructions of [main, explore, general]) {
        expect(instructions).toContain('shared-skill');
        expect(instructions).toContain('共享说明');
        expect(instructions).not.toContain('SHARED_BODY_MARKER');
      }
      const catalogueLines = (instructions: string): string[] => instructions.split('\n').filter((line) => line.startsWith('- shared-skill'));
      expect(catalogueLines(main)).toEqual(['- shared-skill：共享说明']);
      expect(catalogueLines(explore)).toEqual(catalogueLines(main));
      expect(catalogueLines(general)).toEqual(catalogueLines(main));
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