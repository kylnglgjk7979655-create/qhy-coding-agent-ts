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
      const { code, stderr } = await cli.done;
      expect(code).toBe(0);
      expect(diagnosticLines(stderr)).toEqual([]);
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

  it('跳过无效 Skill 时向 stderr 报告路径与原因，有效 Skill 仍正常注册', async () => {
    const cwd = await directory('skill-catalogue-diagnostics-cwd');
    const userDir = await directory('skill-catalogue-diagnostics-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      const projectSkills = join(cwd, '.qhy-coding-agent', 'skills');
      await writeSkill(projectSkills, 'valid', 'name: valid\ndescription: 有效说明', '有效正文');
      await writeSkill(projectSkills, 'missing-description', 'name: missing-description', '缺少说明');
      await writeSkill(projectSkills, 'missing-name', 'description: 缺少名称', '缺少名称');
      await writeSkill(projectSkills, 'malformed', 'name: malformed\ndescription: "UNTERMINATED', '损坏正文');
      await mkdir(join(projectSkills, 'no-frontmatter'), { recursive: true });
      await writeFile(join(projectSkills, 'no-frontmatter', 'SKILL.md'), '没有 frontmatter 的正文');
      await mkdir(join(projectSkills, 'no-skill-file'), { recursive: true });
      await writeFile(join(projectSkills, 'not-a-directory'), '不是目录');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '检查无效 Skill\n/exit\n' });
      const { code, stderr } = await cli.done;
      expect(code).toBe(0);
      expect(model.requests).toHaveLength(1);
      expect(systemText(model.requests[0]!)).toContain('有效说明');

      const diagnostics = diagnosticLines(stderr).join('\n');
      expect(diagnostics).toContain(join(projectSkills, 'missing-description'));
      expect(diagnostics).toMatch(/missing-description.*缺少必填字段.*description/);
      expect(diagnostics).toContain(join(projectSkills, 'missing-name'));
      expect(diagnostics).toMatch(/missing-name.*缺少必填字段.*name/);
      expect(diagnostics).toContain(join(projectSkills, 'malformed'));
      expect(diagnostics).toMatch(/malformed.*frontmatter.*格式无效/);
      expect(diagnostics).toContain(join(projectSkills, 'no-frontmatter'));
      expect(diagnostics).toMatch(/no-frontmatter.*缺少 frontmatter/);
      expect(diagnostics).toContain(join(projectSkills, 'no-skill-file'));
      expect(diagnostics).toMatch(/no-skill-file.*无法读取 SKILL\.md/);
      expect(diagnostics).not.toContain(join(projectSkills, 'valid'));
      expect(diagnostics).not.toContain(join(projectSkills, 'not-a-directory'));
    } finally {
      await model.close();
    }
  });

  it('重载 Skill 时同样报告被跳过目录的诊断', async () => {
    const cwd = await directory('skill-catalogue-reload-cwd');
    const userDir = await directory('skill-catalogue-reload-user');
    const model = await startLocalOpenAIModel(() => ({ content: '已完成。' }));
    try {
      await configure(cwd, model.baseURL);
      const cli = startCLI({
        cwd, userDir, conversationId: 'reload-diagnostics', env: { TEST_MODEL_API_KEY: secret },
      });
      cli.send('第一轮\n');
      await waitForRequests(model.requests, 1);

      const projectSkills = join(cwd, '.qhy-coding-agent', 'skills');
      await writeSkill(projectSkills, 'broken-after-start', 'name: broken-after-start', '运行时出现的无效 Skill');
      cli.end('/resume reload-diagnostics\n/exit\n');
      const { code, stderr } = await cli.done;
      expect(code).toBe(0);
      const diagnostics = diagnosticLines(stderr);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(join(projectSkills, 'broken-after-start'));
      expect(diagnostics[0]).toMatch(/broken-after-start.*缺少必填字段.*description/);
    } finally {
      await model.close();
    }
  });

  it('引号未闭合的 Skill 不进入清单，调用返回 Unknown skill 且不注入正文', async () => {
    const cwd = await directory('skill-catalogue-malformed-cwd');
    const userDir = await directory('skill-catalogue-malformed-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'bad', type: 'function', function: {
        name: 'skill', arguments: JSON.stringify({ name: 'bad' }),
      } }] }
      : { content: '已处理无效 Skill。' });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(cwd, '.qhy-coding-agent', 'skills'), 'bad',
        'name: bad\ndescription: "UNTERMINATED_DESCRIPTION', 'BAD_BODY');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: 'CHECK_INVALID\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(systemText(model.requests[0]!)).not.toContain('UNTERMINATED_DESCRIPTION');
      const results = model.requests[1]!.messages.filter(({ role }) => role === 'tool');
      expect(results.map(({ content }) => JSON.parse(content))).toEqual([{
        is_error: true,
        error: { code: 'TOOL_EXECUTION_ERROR', message: 'Unknown skill: bad' },
      }]);
      expect(JSON.stringify(model.requests)).not.toContain('BAD_BODY');
    } finally {
      await model.close();
    }
  });

  it.each([
    {
      format: '双引号和内联别名',
      metadata: 'name: valid\ndescription: "说明：带 \\"引号\\""\ndisplay_name: "显示名称"\naliases: ["别名,一", 第二别名]',
      description: '说明：带 "引号"',
      identifier: '别名,一',
    },
    {
      format: '单引号和逗号分隔别名',
      metadata: "name: valid\ndescription: 'It''s valid'\naliases: first, second",
      description: "It's valid",
      identifier: 'second',
    },
    {
      format: '字面块说明和块别名',
      metadata: 'name: valid\ndescription: |-\n  第一行\n  第二行\naliases:\n  - first\n  - 第二别名',
      description: '第一行\n第二行',
      identifier: '第二别名',
    },
    {
      format: '折叠块说明',
      metadata: 'name: valid\ndescription: >-\n  第一行\n  第二行\ndisplay_name: 显示名称',
      description: '第一行 第二行',
      identifier: '显示名称',
    },
  ])('保留有效 frontmatter 的$format，清单与调用均可用', async ({ metadata, description, identifier }) => {
    const cwd = await directory('skill-catalogue-formats-cwd');
    const userDir = await directory('skill-catalogue-formats-user');
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'valid', type: 'function', function: {
        name: 'skill', arguments: JSON.stringify({ name: identifier }),
      } }] }
      : { content: '已加载有效 Skill。' });
    try {
      await configure(cwd, model.baseURL);
      await writeSkill(join(cwd, '.qhy-coding-agent', 'skills'), 'valid', metadata, 'VALID_BODY');

      const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret }, input: '加载有效 Skill\n/exit\n' });
      expect((await cli.done).code).toBe(0);
      expect(model.requests).toHaveLength(2);
      expect(systemText(model.requests[0]!)).toContain(`- valid：${description}`);
      expect(model.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'Skill: valid\nVALID_BODY\n' });
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

/** 非交互运行会把运行事件写成 JSON 日志，诊断只保留可读文本行。 */
function diagnosticLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('{'));
}

async function waitForRequests(requests: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (requests.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(requests).toHaveLength(count);
}
