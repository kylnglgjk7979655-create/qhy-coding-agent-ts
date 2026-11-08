import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { handle } = require('../.github/scripts/qa-feedback.cjs') as {
  handle: (args: { github: unknown; context: unknown }) => Promise<unknown>;
};
const { decodeRequest } = require('../.github/scripts/task-queue.cjs') as {
  decodeRequest: (body: string) => { kind: string; status: string; inputs: { expected_head_sha: string } } | undefined;
};

const sha = 'a'.repeat(40);
const repository = 'owner/repo';

function fixture(conclusion = 'failure', failedStep = 'Run pnpm check') {
  const repo = { owner: 'owner', repo: 'repo' };
  const pr = {
    number: 63, state: 'open', body: 'Implemented by the Sandcastle agent workflow.',
    base: { ref: 'main' }, head: { ref: 'agent/issue-24', sha, repo: { full_name: repository } },
    labels: [] as Array<{ name: string }>,
  };
  const run = {
    id: 123, run_attempt: 1, name: 'Check', path: '.github/workflows/check.yml',
    head_repository: { full_name: repository }, head_branch: pr.head.ref, head_sha: sha, conclusion,
  };
  const context = { repo, eventName: 'workflow_run', serverUrl: 'https://github.com',
    payload: { action: 'completed', workflow_run: run },
  };
  const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
  const listComments = vi.fn();
  const listJobsForWorkflowRunAttempt = vi.fn();
  const github = {
    paginate: vi.fn(async (method: unknown) => method === listComments ? comments : [{
      steps: [{ name: failedStep, conclusion: 'failure' }],
    }]),
    rest: {
      pulls: { list: vi.fn(async () => ({ data: [pr] })), get: vi.fn(async () => ({ data: pr })) },
      actions: { createWorkflowDispatch: vi.fn(), listJobsForWorkflowRunAttempt },
      issues: {
        listComments,
        addLabels: vi.fn(), removeLabel: vi.fn(),
        createComment: vi.fn(async ({ body }: { body: string }) => {
          const comment = { id: comments.length + 1, body, user: { login: 'github-actions[bot]' } };
          comments.push(comment);
          return { data: comment };
        }),
      },
    },
  };
  return { run, pr, context, github, comments, apply: () => handle({ github, context }) };
}

describe('Agent QA 反馈', () => {
  it('分支更新在独立工作树执行，恢复、回存和提示词使用固定的可信目录', () => {
    const workflow = readFileSync(new URL('../.github/workflows/agent-update-branch.yml', import.meta.url), 'utf8');
    const prompt = readFileSync(new URL('../.sandcastle/agent-workflows/update-branch/prompt.md', import.meta.url), 'utf8');
    expect(workflow).toContain('ref: ${{ github.workflow_sha }}');
    expect(workflow).toContain('path: worktree');
    expect(workflow).toContain('$GITHUB_WORKSPACE/.sandcastle/agent-workflows/update-branch/update-branch.ts');
    expect(prompt).toContain('gh pr view {{PR_NUMBER}} --json number,title,body,state,baseRefName,headRefName,url');
  });

  it('同一提交的测试失败只入队一次并保留运行链接', async () => {
    const f = fixture();
    await f.apply();
    f.run.id++;
    await f.apply();
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain('https://github.com/owner/repo/actions/runs/123');
    expect(decodeRequest(f.comments[0]!.body)).toMatchObject({ kind: 'implement-pr', status: 'waiting', inputs: { expected_head_sha: sha } });
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledOnce();
    expect(f.github.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['agent:implement'] }));
  });

  it('达到两轮上限后保留诊断并停止追加自动修复', async () => {
    const f = fixture();
    await f.apply();
    for (const next of ['b', 'c']) {
      f.run.id++;
      f.run.head_sha = f.pr.head.sha = next.repeat(40);
      for (const comment of f.comments) {
        // 已完成的修复仍计入预算，后续提交才允许发起下一轮。
        comment.body = comment.body.replace(/<!-- agent-subscription-queue:v1 ([^ ]+) -->/, (_, encoded: string) => {
          const record = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
          record.status = 'completed';
          return `<!-- agent-subscription-queue:v1 ${Buffer.from(JSON.stringify(record)).toString('base64')} -->`;
        });
      }
      await f.apply();
    }
    expect(f.comments).toHaveLength(3);
    expect(f.comments[2]!.body).toContain('两轮上限');
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(2);
  });

  it('检查通过后审查一次，审查后提交变化不会反复启动审查', async () => {
    const f = fixture('success');
    await f.apply();
    f.run.head_sha = f.pr.head.sha = 'b'.repeat(40);
    await f.apply();
    expect(f.comments).toHaveLength(1);
    expect(decodeRequest(f.comments[0]!.body)).toMatchObject({ kind: 'review', inputs: { expected_head_sha: sha } });
  });

  it('父需求的中间提交通过时仍等待最终提交的审查标记', async () => {
    const f = fixture('success');
    f.pr.head.ref = f.run.head_branch = 'agent/parent-24';
    await f.apply();
    expect(f.comments).toHaveLength(0);
    f.comments.push({ id: 1, body: '<!-- agent-qa-review -->', user: { login: 'github-actions[bot]' } });
    await f.apply();
    expect(decodeRequest(f.comments[1]!.body)?.kind).toBe('review');
  });

  it('基础设施失败只报告失败步骤，过期提交和 fork 不发起处理', async () => {
    const f = fixture('failure', 'Setup runner');
    await f.apply();
    await f.apply();
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain('Setup runner');
    f.pr.head.sha = 'b'.repeat(40);
    await f.apply();
    f.pr.head.sha = sha;
    f.run.head_repository.full_name = 'fork/repo';
    await f.apply();
    expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(f.comments).toHaveLength(1);
  });

  it('在同仓库的现有 PR 通过 QA 标签发起一次检查', async () => {
    const f = fixture();
    await handle({ github: f.github, context: { ...f.context, eventName: 'pull_request_target',
      payload: { action: 'labeled', label: { name: 'agent:qa' }, pull_request: f.pr },
    } });
    expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ workflow_id: 'check.yml', ref: f.pr.head.ref }));
    expect(f.github.rest.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 63, name: 'agent:qa' }));
  });
});

