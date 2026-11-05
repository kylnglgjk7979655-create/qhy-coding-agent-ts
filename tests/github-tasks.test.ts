import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { validateResult, reviewPayload } = require('../.github/scripts/task-protocol.cjs');
const { authorize, assertPr, canPromote, prepare, finish, publishSlices, prFeedback, saveDraftPlan, publishApprovedSlices, parsePlan } = require('../.github/scripts/tasks.cjs');
const repo = { owner: 'owner', repo: 'repo' };
const context = { repo, actor: 'maintainer', eventName: 'workflow_dispatch', runId: 123, serverUrl: 'https://github.com', payload: { repository: { private: true, default_branch: 'main' } } };
const validPlan = () => ({ summary: '计划', slices: [{ title: '实现', execution: 'agent', blockedBy: [], whatToBuild: '端到端实现', acceptanceCriteria: ['通过测试'] }, { title: 'QA: 人工验收', execution: 'human-qa', blockedBy: [1], whatToBuild: '运行 CLI 验收', acceptanceCriteria: ['前置：测试数据；操作：运行 CLI；预期：成功输出'] }] });
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'codex-task-test-')); dirs.push(dir); vi.stubEnv('RUNNER_TEMP', dir); return dir; }
const core = () => ({ setOutput: vi.fn(), notice: vi.fn(), setFailed: vi.fn() });
const permission = () => ({ getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: 'write' } }) });
const pr = () => ({ state: 'open', merged: false, head: { sha: 'head', ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha: 'base', ref: 'main', repo: { full_name: 'owner/repo' } } });

describe('任务授权与 PR 边界', () => {
  it('公开仓库在任何 GitHub 请求之前拒绝', async () => {
    await expect(authorize({}, { ...context, payload: { repository: { private: false } } })).rejects.toThrow('私有仓库');
  });
  it('拒绝无写权限的维护者', async () => {
    await expect(authorize({ rest: { repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: 'read' } }) } } }, context)).rejects.toThrow('写权限');
  });
  it('允许 GITHUB_TOKEN 自动派发，无需把 GitHub PAT 交给模型', async () => {
    await expect(authorize({}, { ...context, actor: 'github-actions[bot]' })).resolves.toBeUndefined();
  });
  it('其他机器人或其他事件不会绕过权限检查', async () => {
    const get = vi.fn().mockResolvedValue({ data: { permission: 'none' } });
    const github = { rest: { repos: { getCollaboratorPermissionLevel: get } } };
    await expect(authorize(github, { ...context, actor: 'other[bot]' })).rejects.toThrow();
    await expect(authorize(github, { ...context, actor: 'github-actions[bot]', eventName: 'issues' })).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('拒绝 fork PR、关闭 PR、基准分支作为目标', () => {
    const fork = pr(); fork.head.repo.full_name = 'fork/repo';
    expect(() => assertPr(fork, repo)).toThrow('fork');
    expect(() => assertPr({ ...pr(), state: 'closed' }, repo)).toThrow('关闭');
    const same = pr(); same.head.ref = 'main'; expect(() => assertPr(same, repo)).toThrow('基准分支');
    expect(() => assertPr(pr(), repo)).not.toThrow();
  });
  it('prepare 在读取 PR 分支代码之前拒绝 fork', async () => {
    vi.stubEnv('TASK_MODE', 'review'); vi.stubEnv('TASK_NUMBER', '42');
    const fork = pr(); fork.head.repo.full_name = 'fork/repo';
    const graphql = vi.fn();
    await expect(prepare({ github: { rest: { repos: permission(), git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base' } } }) }, pulls: { get: vi.fn().mockResolvedValue({ data: fork }) } }, graphql }, context, core: core() })).rejects.toThrow('fork');
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('结构化结果与审查评论', () => {
  it.each(['implement', 'review', 'implement-pr', 'update-branch'])('%s 允许没有额外字段的摘要', (mode) => {
    expect(validateResult(mode, { summary: '检查完成' }).summary).toBe('检查完成');
  });
  it('子任务必须明确确认完成，不能静默关闭未实现任务', () => {
    expect(() => validateResult('implement-prd', { summary: '还没完成' })).toThrow('未完成');
    expect(validateResult('implement-prd', { summary: '已验证', completed: true }).completed).toBe(true);
  });
  it('只接受合法架构提案或明确跳过', () => {
    expect(validateResult('architecture', { summary: '重复提案', status: 'skipped' }).status).toBe('skipped');
    expect(() => validateResult('architecture', { summary: 'ok', status: 'proposed', title: '', body: 'abc' })).toThrow();
  });
  it('拒绝空计划、无验收标准、自动关闭指令和过多子任务', () => {
    const plan = validPlan(); const slice = plan.slices[0]!;
    for (const slices of [[], [{ ...slice, acceptanceCriteria: [] }, plan.slices[1]], [{ ...slice, whatToBuild: 'Closes #42' }, plan.slices[1]], Array(31).fill(slice)]) {
      expect(() => validateResult('to-issues', { summary: '计划', slices })).toThrow();
    }
    expect(validateResult('to-issues', plan).slices).toHaveLength(2);
  });
  it('拒绝伪造行号和回复 ID，去掉未知输出字段', () => {
    expect(() => validateResult('review', { summary: 'ok', inlineComments: [{ path: 'x', line: -1, body: 'abc' }] })).toThrow();
    expect(() => validateResult('review', { summary: 'ok', replies: [{ commentId: '123', body: 'abc' }] })).toThrow();
    expect(validateResult('implement', { summary: 'ok', token: 'should-drop' })).not.toHaveProperty('token');
  });
  it('行内评论只发布到最终 diff 的右侧行，失效行回落到摘要，不自动批准', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n';
    const result = { summary: '结论', inlineComments: [{ path: 'a.ts', line: 2, body: '有效' }, { path: 'a.ts', line: 99, body: '过期' }, { path: 'missing', line: 1, body: '文件不在 diff' }] };
    const payload = reviewPayload(result, patch, 'sha');
    expect(payload.event).toBe('COMMENT'); expect(payload.commit_id).toBe('sha');
    expect(payload.comments).toEqual([{ path: 'a.ts', line: 2, body: '有效', side: 'RIGHT' }]);
    expect(payload.body).toContain('a.ts:99'); expect(payload.body).toContain('missing:1');
  });
});

describe('依赖队列与自动接续', () => {
  it('只运行开放且全部依赖真正完成的根 Issue', () => {
    const issue = { state: 'open', labels: [{ name: 'agent:queued' }] };
    expect(canPromote(issue, null, [{ state: 'CLOSED', stateReason: 'COMPLETED' }])).toBe(true);
    expect(canPromote(issue, null, [{ state: 'OPEN' }])).toBe(false);
    expect(canPromote(issue, null, [{ state: 'CLOSED', stateReason: 'NOT_PLANNED' }])).toBe(false);
    expect(canPromote(issue, { number: 1 }, [])).toBe(false);
    expect(canPromote({ ...issue, labels: ['agent:queued', 'agent:in-progress'] }, null, [])).toBe(false);
    expect(canPromote({ ...issue, labels: ['agent:queued', 'agent:blocked'] }, null, [])).toBe(false);
    expect(canPromote({ ...issue, state: 'closed' }, null, [])).toBe(false);
  });
  it('发布失败不接续、不关闭任务，清理进行中状态', async () => {
    vi.stubEnv('TASK_SUBJECT', '42'); vi.stubEnv('PUBLISH_RESULT', 'failure'); vi.stubEnv('NEXT_TASK', 'review');
    const actions = { createWorkflowDispatch: vi.fn() };
    const issues = { addLabels: vi.fn(), removeLabel: vi.fn(), createComment: vi.fn() };
    await finish({ github: { rest: { actions, issues } }, context, core: core() });
    expect(actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(issues.addLabels).toHaveBeenCalledWith({ ...repo, issue_number: 42, labels: ['agent:blocked'] });
    expect(issues.removeLabel).toHaveBeenCalledWith({ ...repo, issue_number: 42, name: 'agent:in-progress' });
  });
  it('成功后通过 workflow_dispatch 启动审查，支持 GITHUB_TOKEN', async () => {
    vi.stubEnv('TASK_SUBJECT', '42'); vi.stubEnv('PUBLISH_RESULT', 'success'); vi.stubEnv('NEXT_TASK', 'review'); vi.stubEnv('RESULT_PR', '43');
    const dispatch = vi.fn(); const issues = { removeLabel: vi.fn(), createComment: vi.fn() };
    await finish({ github: { rest: { actions: { createWorkflowDispatch: dispatch }, issues } }, context, core: core() });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ ...repo, workflow_id: 'agent-review.yml', ref: 'main', inputs: { pr_number: '43' } });
  });
  it('接续失败给出手动恢复说明，仍然移除进行中状态', async () => {
    vi.stubEnv('TASK_SUBJECT', '42'); vi.stubEnv('PUBLISH_RESULT', 'success'); vi.stubEnv('NEXT_TASK', 'implement-prd');
    const dispatch = vi.fn().mockRejectedValue(new Error('denied')); const issues = { removeLabel: vi.fn(), createComment: vi.fn() }; const c = core();
    await finish({ github: { rest: { actions: { createWorkflowDispatch: dispatch }, issues } }, context, core: c });
    expect(c.setFailed).toHaveBeenCalled(); expect(issues.removeLabel).toHaveBeenCalled();
    expect(issues.createComment.mock.calls.some(([args]) => args.body.includes('手动触发'))).toBe(true);
  });
});

describe('PRD 拆分故障恢复', () => {
  it('审批后创建成功但挂接失败，重试复用原计划及原 Issue，并补齐依赖', async () => {
    const plan = validPlan();
    const comments = [{ id: 10, user: { login: 'github-actions[bot]' }, body: `<!-- codex-prd-plan -->${JSON.stringify(plan)}`, created_at: '2026-11-05T01:00:00Z', updated_at: '2026-11-05T01:00:00Z' }];
    const all: Array<{ id: number; number: number; body: string }> = [];
    const current: typeof all = [];
    const create = vi.fn(async (args) => { const issue = { id: 100 + all.length, number: 50 + all.length, body: args.body }; all.push(issue); return { data: issue }; });
    const request = vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(async (route, args) => {
      if (route.includes('sub_issues')) current.push(all.find((issue) => issue.id === args.sub_issue_id)!);
    });
    const github = { rest: { issues: { listComments: 'comments', listForRepo: 'all', create, createComment: vi.fn() } }, request,
      paginate: vi.fn(async (route) => route === 'comments' ? [...comments] : route === 'all' ? [...all] : route.includes('dependencies') ? [] : [...current]) };
    await expect(publishSlices(github, context, { number: 42 }, comments[0])).rejects.toThrow('network');
    await publishSlices(github, context, { number: 42 }, comments[0]);
    expect(create).toHaveBeenCalledTimes(2); expect(current).toHaveLength(2);
    expect(create.mock.calls[0]?.[0].labels).toEqual(['ready-for-agent']);
    expect(create.mock.calls[1]?.[0].labels).toEqual(['ready-for-human']);
    expect(create.mock.calls[1]?.[0].body).toContain('Execution:** Human QA (HITL)');
    expect(request).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', { ...repo, issue_number: 51, issue_id: 100 });
  });
  it('规划阶段只保存完整计划，不创建 Issue；缺少保存的计划不能发布', async () => {
    const createComment = vi.fn(); const create = vi.fn();
    const github = { rest: { issues: { listComments: 'comments', listForRepo: 'all', createComment, create } }, paginate: vi.fn().mockResolvedValue([]) };
    await saveDraftPlan(github, context, { number: 42 }, validPlan());
    expect(createComment.mock.calls[0]?.[0].body).toContain('agent:publish-tickets');
    expect(parsePlan({ user: { login: 'github-actions[bot]' }, body: createComment.mock.calls[0]?.[0].body })).toEqual(validPlan());
    expect(create).not.toHaveBeenCalled();
    await expect(publishSlices(github, context, { number: 42 }, validPlan())).rejects.toThrow('缺少已保存');
  });
  it('审批之后生成或修改的计划不能据此发布', async () => {
    vi.stubEnv('TASK_NUMBER', '42');
    const comment = { user: { login: 'github-actions[bot]' }, body: `<!-- codex-prd-plan -->${JSON.stringify(validPlan())}`, created_at: '2026-11-05T01:00:00Z', updated_at: '2026-11-05T02:00:00Z' };
    const create = vi.fn();
    const github = { rest: { repos: permission(), issues: { get: vi.fn().mockResolvedValue({ data: { state: 'open' } }), listComments: 'comments', create }, actions: { getWorkflowRun: vi.fn().mockResolvedValue({ data: { created_at: '2026-11-05T01:30:00Z' } }) } }, graphql: vi.fn().mockResolvedValue({ repository: { issue: { parent: null } } }), paginate: vi.fn().mockResolvedValue([comment]) };
    await expect(publishApprovedSlices({ github, context, core: core() })).rejects.toThrow('审批触发之后');
    expect(create).not.toHaveBeenCalled();
  });
  it('PR thread 评论超过读取上限时停止，不静默遗漏反馈', async () => {
    const github = { rest: { issues: { listComments: 'comments' }, pulls: { listReviews: 'reviews' } }, paginate: vi.fn().mockResolvedValue([]), graphql: vi.fn().mockResolvedValue({ repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, comments: { pageInfo: { hasNextPage: true } } }], pageInfo: { hasNextPage: false } } } } }) };
    await expect(prFeedback(github, repo, 42)).rejects.toThrow('100');
  });
  it('架构 prepare 使用默认分支并保存历史提案，不需要 Issue 编号', async () => {
    const dir = await temporary(); vi.stubEnv('TASK_MODE', 'architecture'); vi.stubEnv('TASK_NUMBER', '0');
    const c = core(); const github = { rest: { repos: permission(), git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base' } } }) }, issues: { listForRepo: 'issues', getLabel: vi.fn() } }, paginate: vi.fn().mockResolvedValue([{ title: '已有提案' }]) };
    await prepare({ github, context, core: c });
    const task = JSON.parse(await readFile(join(dir, 'codex-context/task.json'), 'utf8'));
    expect(task.mode).toBe('architecture'); expect(task.proposals).toHaveLength(1); expect(task.sha).toBe('base');
    expect(c.setOutput).toHaveBeenCalledWith('proceed', 'true');
  });
});

describe('Issue 与 PRD 自动路由', () => {
  async function issueFixture(children: Array<{ number: number; state: string }>) {
    const dir = await temporary(); vi.stubEnv('TASK_MODE', 'implement'); vi.stubEnv('TASK_NUMBER', '42');
    const c = core();
    const github = { rest: {
      repos: permission(), git: { getRef: vi.fn().mockImplementation(async ({ ref }) => {
        if (ref === 'heads/main') return { data: { object: { sha: 'main-sha' } } };
        throw Object.assign(new Error('not found'), { status: 404 });
      }) },
      issues: { get: vi.fn().mockResolvedValue({ data: { number: 42, title: '需求', body: '验收条件', state: 'open' } }), listComments: 'comments', getLabel: vi.fn(), removeLabel: vi.fn(), addLabels: vi.fn() }, pulls: { list: 'prs' },
    }, graphql: vi.fn().mockImplementation(async (query) => query.includes('blockedBy')
      ? { repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } }
      : { repository: { issue: { parent: null } } }),
    paginate: vi.fn().mockImplementation(async (route, args) => typeof route === 'string' && route.includes('sub_issues') && args.issue_number === 42 ? children : []),
    };
    return { dir, c, github };
  }
  it('普通 Issue 使用唯一分支；含子 Issue 的父需求使用稳定 PRD 分支并选择第一个开放任务', async () => {
    const ordinary = await issueFixture([]); await prepare({ github: ordinary.github, context, core: ordinary.c });
    const single = JSON.parse(await readFile(join(ordinary.dir, 'codex-context/task.json'), 'utf8'));
    expect(single.mode).toBe('implement'); expect(single.branch).toMatch(/^codex\/issue-42-123-/);
    const children = [{ number: 50, state: 'closed' }, { number: 51, state: 'open' }, { number: 52, state: 'open' }];
    const f = await issueFixture(children);
    f.github.paginate.mockImplementation(async (route, args) => route === 'comments' && args.issue_number === 51 ? [{ id: 100, user: { login: 'maintainer' }, body: '评论补充的验收条件' }] : route.includes('sub_issues') && args.issue_number === 42 ? children : []);
    await prepare({ github: f.github, context, core: f.c });
    const task = JSON.parse(await readFile(join(f.dir, 'codex-context/task.json'), 'utf8'));
    expect(task.mode).toBe('implement-prd'); expect(task.branch).toBe('codex/prd-42'); expect(task.child.number).toBe(51);
    expect(task.child.comments[0].body).toBe('评论补充的验收条件');
  });
  it('拒绝直接启动子 Issue 或嵌套 PRD，不把它当普通任务', async () => {
    const child = await issueFixture([]); child.github.graphql.mockResolvedValue({ repository: { issue: { parent: { number: 1 } } } });
    await expect(prepare({ github: child.github, context, core: child.c })).rejects.toThrow('父 PRD');
    const nested = await issueFixture([{ number: 51, state: 'open' }]);
    nested.github.paginate.mockImplementation(async (route, args) => route.includes('sub_issues') ? [{ number: args.issue_number + 1, state: 'open' }] : []);
    await expect(prepare({ github: nested.github, context, core: nested.c })).rejects.toThrow('嵌套');
  });
  it('全部子任务已关闭时跳过，不重复调用模型', async () => {
    const f = await issueFixture([{ number: 51, state: 'closed' }]);
    await prepare({ github: f.github, context, core: f.c });
    expect(f.c.setOutput).not.toHaveBeenCalledWith('proceed', 'true'); expect(f.github.rest.issues.addLabels).not.toHaveBeenCalled();
  });
});

describe('显式触发代码检查', () => {
  it('GITHUB_TOKEN 发布后在 PR 分支启动 Check，再接续审查', async () => {
    vi.stubEnv('TASK_SUBJECT', '42'); vi.stubEnv('PUBLISH_RESULT', 'success'); vi.stubEnv('NEXT_TASK', 'review');
    vi.stubEnv('RESULT_PR', '43'); vi.stubEnv('CODE_CHANGED', 'true'); vi.stubEnv('RESULT_BRANCH', 'codex/issue-42-123-1');
    const dispatch = vi.fn(); const issues = { removeLabel: vi.fn(), createComment: vi.fn() };
    await finish({ github: { rest: { actions: { createWorkflowDispatch: dispatch }, issues } }, context, core: core() });
    expect(dispatch.mock.calls.map(([args]) => [args.workflow_id, args.ref])).toEqual([['check.yml', 'codex/issue-42-123-1'], ['agent-review.yml', 'main']]);
  });
});


describe('架构积压门禁', () => {
  it('已有10个开放提案时在读取认证或调用模型前跳过', async () => {
    vi.stubEnv('TASK_MODE', 'architecture'); vi.stubEnv('TASK_NUMBER', '0');
    const c = core(); const github = { rest: { repos: permission(), git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base' } } }) }, issues: { listForRepo: 'issues' } }, paginate: vi.fn().mockResolvedValue(Array.from({ length: 10 }, () => ({ state: 'open' }))) };
    await prepare({ github, context, core: c });
    expect(c.setOutput).not.toHaveBeenCalledWith('proceed', 'true'); expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('10个'));
  });
});


describe('人工 QA 的父规格上下文', () => {
  it('PR 仅用 Refs 关联父规格时，需求审查仍读取规格和子任务', async () => {
    const dir = await temporary(); vi.stubEnv('TASK_MODE', 'review'); vi.stubEnv('TASK_NUMBER', '43');
    const c = core();
    const github = { rest: {
      repos: permission(), git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base' } } }) },
      pulls: { get: vi.fn().mockResolvedValue({ data: { ...pr(), number: 43, body: 'Refs #42' } }), listReviews: 'reviews' },
      issues: { get: vi.fn().mockResolvedValue({ data: { title: '父规格', state: 'open', body: '完整验收要求' } }), listComments: 'comments', getLabel: vi.fn(), removeLabel: vi.fn(), addLabels: vi.fn() },
    }, paginate: vi.fn().mockImplementation(async (route) => route.includes('sub_issues') ? [{ number: 51, state: 'closed' }, { number: 52, state: 'open', title: 'QA: 验收' }] : []),
    graphql: vi.fn().mockResolvedValue({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
    };
    await prepare({ github, context, core: c });
    const task = JSON.parse(await readFile(join(dir, 'codex-context/task.json'), 'utf8'));
    expect(task.linkedIssues[0].number).toBe(42); expect(task.linkedIssues[0].children).toHaveLength(2);
  });
});


describe('审批快照不可替换', () => {
  it.each(['body', 'updated_at'])('两次读取间 %s 变化时，不发布新计划', async (field) => {
    const original = { id: 10, user: { login: 'github-actions[bot]' }, body: `<!-- codex-prd-plan -->${JSON.stringify(validPlan())}`, created_at: '2026-11-05T01:00:00Z', updated_at: '2026-11-05T01:00:00Z' };
    const latest = { ...original, [field]: field === 'body' ? `<!-- codex-prd-plan -->${JSON.stringify({ ...validPlan(), summary: '未审批的新计划' })}` : '2026-11-05T02:00:00Z' };
    const create = vi.fn();
    const github = { rest: { issues: { listComments: 'comments', create } }, paginate: vi.fn().mockImplementation(async (route) => route === 'comments' ? [latest] : []) };
    await expect(publishSlices(github, context, { number: 42 }, original)).rejects.toThrow('快照已变化');
    expect(create).not.toHaveBeenCalled();
  });
});
