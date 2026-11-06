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
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: 'ok', completed: true, replies: [{ commentId: 999, body: 'bad target' }] }));
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('未提供');
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });
  it.each(['architecture', 'code-design'])('%s 修改源码时拒绝导出，不允许发布', async (mode) => {
    const f = await fixture(mode); await writeFile(join(f.work, 'a.txt'), 'changed\n');
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify(mode === 'code-design' ? { summary: '设计', completed: true, title: '设计方案', body: '推荐方案' } : { summary: 'skip', status: 'skipped' }));
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
  it.each(['implement', 'bugfix'])('未完成的 %s 任务不会导出成功结果', async (mode) => {
    const f = await fixture(mode);
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: '尚未完成', completed: false }));
    await expect(exportPatch()).rejects.toThrow('未完成');
    expect(f.github.rest.issues.update).not.toHaveBeenCalled();
  });
});

describe('子 Issue 的独立发布与设计交付', () => {
  async function childFixture() {
    const f = await fixture('implement');
    const task = { ...f.task, number: 51, subject: 51, parent: { number: 42 }, issue: { title: '第一片' } };
    await writeFile(join(f.root, 'codex-context/task.json'), JSON.stringify(task));
    f.github.graphql.mockImplementation(async (query: string) => query.includes('blockedBy')
      ? { repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } }
      : { repository: { issue: { parent: { number: 42 } } } });
    const create = vi.fn().mockResolvedValue({ data: { ...f.pr, number: 99 } });
    Object.assign(f.github.rest.pulls, { create });
    return { ...f, create };
  }
  it('子任务独立 PR 只关闭当前任务，创建或审查成功均不提前关闭 Issue', async () => {
    const f = await childFixture();
    await writeFile(join(f.work, 'a.txt'), 'independent slice\n');
    await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    expect(git(f.remote, 'show', 'feature:a.txt')).toBe('independent slice');
    expect(f.github.rest.issues.update).not.toHaveBeenCalled();
    const body = f.create.mock.calls[0]![0].body;
    expect(body).toContain('Closes #51'); expect(body).toContain('Part of #42'); expect(body).not.toContain('Closes #42');
    expect(f.core.setOutput).toHaveBeenCalledWith('next', 'review');
  });
  it('执行期间改成人工任务时，在推送之前停止', async () => {
    const f = await childFixture();
    await writeFile(join(f.work, 'a.txt'), 'should not publish\n');
    await exportPatch(); git(f.work, 'reset', '--hard', f.head);
    f.github.rest.issues.get.mockResolvedValue({ data: { state: 'open', labels: ['ready-for-human'] } });
    await expect(publish({ github: f.github, context, core: f.core, cwd: f.work })).rejects.toThrow('人工执行');
    expect(git(f.remote, 'rev-parse', 'feature')).toBe(f.head);
  });
  it('设计只发布方案评论，保持代码、Issue 和 PR 不变', async () => {
    const f = await fixture('code-design');
    await writeFile(join(f.root, 'codex-result/result.json'), JSON.stringify({ summary: '设计完成', completed: true, title: '接口设计', body: '方案 A、B 比较与推荐' }));
    f.github.rest.issues.createComment.mockResolvedValue({ data: { html_url: 'design-comment' } });
    await exportPatch();
    await publish({ github: f.github, context, core: f.core, cwd: f.work });
    expect(f.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42, body: expect.stringContaining('方案 A、B') }));
    expect(f.github.rest.issues.update).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.update).not.toHaveBeenCalled();
    expect(git(f.remote, 'rev-parse', 'feature')).toBe(f.head);
    expect(f.core.setOutput).toHaveBeenCalledWith('url', 'design-comment');
  });
});
