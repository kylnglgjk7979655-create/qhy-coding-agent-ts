import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { publish, exportPatch } = require('../.github/scripts/tasks.cjs');
const dirs: string[] = [];
const context = { repo: { owner: 'owner', repo: 'repo' }, payload: { repository: { default_branch: 'main' } } };
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'codex-publish-')); dirs.push(root);
  const remote = join(root, 'remote.git'); const work = join(root, 'work');
  await mkdir(work); git(root, 'init', '--bare', remote); git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.name', 'test'); git(work, 'config', 'user.email', 'test@example.com');
  await writeFile(join(work, 'a.txt'), 'original\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'initial');
  const ancestor = git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'base.txt'), 'base addition\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base advances');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', 'feature', ancestor);
  await writeFile(join(work, 'feature.txt'), 'feature\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'feature');
  const head = git(work, 'rev-parse', 'HEAD'); git(work, 'remote', 'add', 'origin', remote); git(work, 'push', 'origin', 'feature', 'main');
  const task = { mode, number: 42, subject: 42, base: 'main', baseSha: base, sha: head, branch: 'feature', feedback: { threads: [] } };
  vi.stubEnv('RUNNER_TEMP', root); vi.stubEnv('AGENT_WORKSPACE', work);
  await mkdir(join(root, 'codex-context')); await mkdir(join(root, 'codex-result'));
  await writeFile(join(root, 'codex-context/task.json'), JSON.stringify(task));
  await writeFile(join(root, 'codex-result/result.json'), JSON.stringify({ summary: '验证通过', completed: true }));
  const pr = { number: 42, node_id: 'node', state: 'open', merged: false, html_url: 'url', draft: false, head: { sha: head, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } } };
  const github = { rest: {
    pulls: { get: vi.fn().mockImplementation(async () => ({ data: pr })), createReview: vi.fn(), update: vi.fn(), createReplyForReviewComment: vi.fn() },
    issues: { createComment: vi.fn(), get: vi.fn().mockResolvedValue({ data: { state: 'open' } }), update: vi.fn() },
    git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: base } } }) },
  }, paginate: vi.fn().mockResolvedValue([]), graphql: vi.fn().mockResolvedValue({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } }) };
  const core = { setOutput: vi.fn() };
  return { root, work, remote, task, pr, base, head, github, core };
}
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('真实 git 发布与导出', () => {
  it('更新分支创建双父 merge commit，保留两侧文件', async () => {
    const f = await fixture('update-branch');
    git(f.work, 'merge', '--no-commit', '--no-ff', f.base);
    await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    const commit = git(f.remote, 'rev-parse', 'feature');
    expect(git(f.remote, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1)).toEqual([f.head, f.base]);
    expect(git(f.remote, 'show', 'feature:base.txt')).toBe('base addition');
    expect(git(f.remote, 'show', 'feature:feature.txt')).toBe('feature');
  });
  it('PR 在模型运行期间新增提交时，在推送和评论前停止', async () => {
    const f = await fixture('implement-pr'); await writeFile(join(f.work, 'a.txt'), 'fix\n'); await exportPatch();
    f.pr.head.sha = 'new-head';
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('变化');
    expect(git(f.remote, 'rev-parse', 'feature')).toBe(f.head);
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it('API 检查后远端新增提交时，普通 git push 拒绝覆盖', async () => {
    const f = await fixture('implement-pr'); await writeFile(join(f.work, 'a.txt'), 'agent fix\n'); await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await writeFile(join(f.work, 'human.txt'), 'human\n'); git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'human'); git(f.work, 'push', 'origin', 'feature');
    const human = git(f.remote, 'rev-parse', 'feature'); git(f.work, 'reset', '--hard', f.head);
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow();
    expect(git(f.remote, 'rev-parse', 'feature')).toBe(human);
  });
  it('伪造 thread 回复在任何代码推送之前拒绝', async () => {
    const f = await fixture('review'); await exportPatch();
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: 'ok', replies: [{ commentId: 999, body: 'bad target' }] }));
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('未提供');
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });
  it('只读任务修改源码时拒绝导出，不允许发布', async () => {
    const f = await fixture('architecture'); await writeFile(join(f.work, 'a.txt'), 'changed\n');
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: 'skip', status: 'skipped' }));
    await expect(exportPatch()).rejects.toThrow('只读');
  });
  it('没有修改的审查仍可发布 COMMENT；单 Issue 不允许空补丁', async () => {
    const f = await fixture('review'); await exportPatch();
    expect(await readFile(join(f.root, 'codex-result/changes.patch'), 'utf8')).toBe('');
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    expect(f.github.rest.pulls.createReview).toHaveBeenCalledWith(expect.objectContaining({ event: 'COMMENT', commit_id: f.head }));
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify({ ...f.task, mode: 'implement' }));
    await expect(exportPatch()).rejects.toThrow('没有产生修改');
  });
  it('未完成的 PRD 子任务不会导出成功结果', async () => {
    const f = await fixture('implement-prd');
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: '尚未完成', completed: false }));
    await expect(exportPatch()).rejects.toThrow('未完成');
    expect(f.github.rest.issues.update).not.toHaveBeenCalled();
  });
});

describe('PRD 逐轮发布', () => {
  it.each([true, false])('发布成功后才关闭本轮子任务，remaining=%s', async (hasRemaining) => {
    const f = await fixture('implement-prd'); f.pr.number = 43;
    const child = { id: 51, number: 51, state: 'open', title: '第一片' };
    const children = hasRemaining ? [child, { id: 52, number: 52, state: 'open', title: '第二片' }] : [child];
    const task = { ...f.task, existingPr: 43, child, children, issue: { title: 'PRD' } };
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify(task));
    f.github.paginate.mockImplementation(async (route) => typeof route === 'string' ? children : [f.pr]);
    await writeFile(join(f.work, 'a.txt'), 'slice implemented\n'); await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    expect(git(f.remote, 'show', 'feature:a.txt')).toBe('slice implemented');
    expect(f.github.rest.issues.update).toHaveBeenCalledExactlyOnceWith({ ...context.repo, issue_number: 51, state: 'closed', state_reason: 'completed' });
    expect(f.core.setOutput).toHaveBeenCalledWith('next', hasRemaining ? 'implement-prd' : 'review');
    expect(f.github.rest.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 43, body: expect.stringContaining('- [x] #51') }));
  });
  it('推送后 PR 发布失败的子任务仍保持开放，供下轮恢复', async () => {
    const f = await fixture('implement-prd');
    const child = { number: 51, state: 'open' };
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify({ ...f.task, child, children: [child], issue: { title: 'PRD' } }));
    f.github.paginate.mockImplementation(async (route) => typeof route === 'string' ? [child] : []);
    // 没有开放 PR 时创建失败；即使分支已推送也不能提前关闭子任务。
    Object.assign(f.github.rest.pulls, { create: vi.fn().mockRejectedValue(new Error('PR creation denied')) });
    await writeFile(join(f.work, 'a.txt'), 'slice implemented\n'); await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('PR creation denied');
    expect(f.github.rest.issues.update).not.toHaveBeenCalled();
    expect(f.core.setOutput).not.toHaveBeenCalledWith('next', expect.anything());
  });
});

describe('人工 QA 发布边界', () => {
  it('最后一个实现完成后进入审查，QA 保持开放，父单只关联', async () => {
    const f = await fixture('implement-prd'); f.pr.number = 43;
    const child = { number: 51, state: 'open' };
    const qa = { number: 52, state: 'open', title: 'QA: 验收', labels: ['ready-for-human'] };
    const children = [child, qa];
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify({ ...f.task, existingPr: 43, child, children, issue: { title: 'PRD' } }));
    f.github.paginate.mockImplementation(async (route) => typeof route === 'string' ? children : [f.pr]);
    await writeFile(join(f.work, 'a.txt'), 'implemented\n'); await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    expect(f.github.rest.issues.update).toHaveBeenCalledExactlyOnceWith({ ...context.repo, issue_number: 51, state: 'closed', state_reason: 'completed' });
    expect(f.core.setOutput).toHaveBeenCalledWith('next', 'review');
    const body = f.github.rest.pulls.update.mock.calls[0]?.[0].body;
    expect(body).toContain('Refs #42'); expect(body).not.toContain('Closes #42'); expect(body).toContain('- [ ] #52（人工 QA）');
  });
  it('任务执行期间被改成人工 QA，在推送之前停止', async () => {
    const f = await fixture('implement-prd');
    const child = { number: 51, state: 'open', labels: ['ready-for-human'] };
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify({ ...f.task, child, children: [child], issue: { title: 'PRD' } }));
    f.github.paginate.mockImplementation(async (route) => typeof route === 'string' ? [child] : []);
    await writeFile(join(f.work, 'a.txt'), 'should not publish\n'); await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('人工任务');
    expect(git(f.remote, 'rev-parse', 'feature')).toBe(f.head); expect(f.github.rest.issues.update).not.toHaveBeenCalled();
  });
});
