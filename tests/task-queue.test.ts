import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const queue = require('../.github/scripts/task-queue.cjs') as {
  decodeRequest: (body: string) => Record<string, unknown> | undefined;
  enqueue: (args: { github: unknown; context: unknown; request: Record<string, unknown> }) => Promise<unknown>;
  listWaiting: (args: { github: unknown; context: unknown }) => Promise<Array<{ request: { id: string; workflow: string }; commentId: number }>>;
  transition: (args: { github: unknown; context: unknown; number: number; commentId: number; status: string; authFingerprint?: string; reason?: string }) => Promise<unknown>;
};
const worker = require('../.github/scripts/queue-worker.cjs') as {
  stillAuthorized: (github: unknown, context: unknown, request: { number: number; inputs: Record<string, string> }) => Promise<string | undefined>;
  authFingerprint: () => string;
  recoverRunning: (github: unknown, context: unknown) => Promise<boolean>;
};
const ingress = require('../.github/scripts/queue-ingress.cjs') as {
  route: (args: { github: unknown; context: Record<string, unknown> }) => Promise<unknown>;
};

type Comment = { id: number; body: string; user: { login: string } };
const context = { repo: { owner: 'org', repo: 'project' } };
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const comments = new Map<number, Comment[]>();
  let nextId = 1;
  const github = {
    paginate: vi.fn(async (_method: unknown, args: { issue_number?: number }) => {
      if (args.issue_number !== undefined) return comments.get(args.issue_number) ?? [];
      return [11, 12, 13].map((number) => ({ number, html_url: `https://github.com/org/project/issues/${number}` }));
    }),
    rest: { actions: { createWorkflowDispatch: vi.fn(async () => ({})) }, issues: {
      listComments: vi.fn(), listForRepo: vi.fn(),
      createComment: vi.fn(async ({ issue_number, body }: { issue_number: number; body: string }) => {
        const comment = { id: nextId++, body, user: { login: 'github-actions[bot]' } };
        comments.set(issue_number, [...(comments.get(issue_number) ?? []), comment]);
        return { data: comment };
      }),
      updateComment: vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
        for (const [number, entries] of comments) {
          comments.set(number, entries.map((entry) => entry.id === comment_id ? { ...entry, body } : entry));
        }
      }),
    } },
  };
  return { github, comments };
}

function request(id: string, number: number, queuedAt: string, kind = 'implement', workflow = 'agent-implement.yml') {
  const pullRequest = ['review', 'implement-pr', 'update-branch'].includes(kind);
  return {
    id, kind, number, workflow,
    inputs: {
      [pullRequest ? 'pr_number' : 'issue_number']: String(number),
      authorization_label: kind === 'review' ? 'agent:review' : kind === 'update-branch' ? 'agent:update-branch' : 'agent:implement',
      ...(pullRequest ? { expected_head_sha: 'a'.repeat(40) } : {}),
      ...(kind === 'explore' ? { dry_run: 'false' } : {}),
    },
    queuedAt,
  };
}

describe('订阅 Agent 持久化队列', () => {
  it('标签入口使用已部署的 workflow 和同一提交中的脚本', () => {
    const workflow = readFileSync(new URL('../.github/workflows/agent-queue-ingress.yml', import.meta.url), 'utf8');
    expect(workflow).not.toMatch(/^  pull_request:/mu);
    expect(workflow).toMatch(/^  pull_request_target:\n    types: \[labeled\]/mu);
    expect(workflow).toContain('ref: ${{ github.workflow_sha }}');
  });

  it('保存三个不同请求并按入队时间排序，重复投递保持幂等', async () => {
    const h = fixture();
    await queue.enqueue({ github: h.github, context, request: request('evt-3', 13, '2026-11-08T10:03:00Z', 'update-branch', 'agent-update-branch.yml') });
    await queue.enqueue({ github: h.github, context, request: request('evt-1', 11, '2026-11-08T10:01:00Z') });
    await queue.enqueue({ github: h.github, context, request: request('evt-2', 12, '2026-11-08T10:02:00Z', 'review', 'agent-review.yml') });
    const duplicate = await queue.enqueue({ github: h.github, context, request: request('evt-2', 12, '2026-11-08T10:02:00Z', 'review', 'agent-review.yml') });

    expect((await queue.listWaiting({ github: h.github, context })).map((entry) => entry.request.id))
      .toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(duplicate).toMatchObject({ id: 'evt-2', duplicate: true });
    expect(h.github.rest.issues.createComment).toHaveBeenCalledTimes(3);
    const serialized = [...h.comments.values()].flat().map((comment) => comment.body).join('\n');
    expect(serialized).not.toContain('CODEX_AUTH_JSON');
  });

  it('混合 Issue 和 PR 入口统一持久化，重复事件只创建一个请求', async () => {
    const h = fixture();
    const issueEvent = {
      ...context, runId: 50, eventName: 'issues',
      payload: { action: 'labeled', label: { name: 'agent:implement' }, issue: { number: 11, updated_at: '2026-11-08T10:00:00Z' } },
    };
    await ingress.route({ github: h.github, context: issueEvent });
    await ingress.route({ github: h.github, context: { ...issueEvent, runId: 51 } });
    await ingress.route({
      github: h.github,
      context: {
        ...context, runId: 52, eventName: 'pull_request_target',
        payload: { action: 'labeled', label: { name: 'agent:review' }, pull_request: {
          number: 12, state: 'open', updated_at: '2026-11-08T10:01:00Z',
          head: { sha: 'a'.repeat(40), repo: { full_name: 'org/project' } },
        } },
      },
    });
    await ingress.route({
      github: h.github,
      context: {
        ...context, runId: 53, eventName: 'issues',
        payload: { action: 'labeled', label: { name: 'agent:explore' }, issue: { number: 13, updated_at: '2026-11-08T10:02:00Z' } },
      },
    });
    expect(h.github.rest.issues.createComment).toHaveBeenCalledTimes(3);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(4);
    expect((await queue.listWaiting({ github: h.github, context })).map((entry) => entry.request.workflow))
      .toEqual(['agent-implement.yml', 'agent-review.yml', 'agent-explore.yml']);
  });

  it.each([
    ['agent:implement', 'agent-implement-pr.yml'],
    ['agent:review', 'agent-review.yml'],
    ['agent:update-branch', 'agent-update-branch.yml'],
  ])('从可信 PR 标签事件路由 %s，忽略 fork、关闭的 PR 和旧事件', async (label, workflow) => {
    const h = fixture();
    const pull = {
      number: 12, state: 'open', updated_at: '2026-11-08T10:01:00Z',
      head: { sha: 'a'.repeat(40), repo: { full_name: 'org/project' } },
    };
    const event = { ...context, eventName: 'pull_request_target', payload: { action: 'labeled', label: { name: label }, pull_request: pull } };
    for (const pr of [
      { ...pull, head: { ...pull.head, repo: { full_name: 'fork/project' } } },
      { ...pull, state: 'closed' },
    ]) {
      await expect(ingress.route({ github: h.github, context: { ...event, payload: { ...event.payload, pull_request: pr } } }))
        .resolves.toMatchObject({ ignored: true });
    }
    await expect(ingress.route({ github: h.github, context: { ...event, eventName: 'pull_request' } }))
      .resolves.toMatchObject({ ignored: true });
    expect(h.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();

    await ingress.route({ github: h.github, context: event });
    await ingress.route({ github: h.github, context: event });
    expect(h.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect((await queue.listWaiting({ github: h.github, context })).map((entry) => entry.request.workflow)).toEqual([workflow]);
    expect(h.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: 'agent-queue.yml', ref: 'main',
    }));
  });

  it('状态转换保留审计记录，并禁止重放已终结请求', async () => {
    const h = fixture();
    const queued = await queue.enqueue({ github: h.github, context, request: request('evt-1', 11, '2026-11-08T10:01:00Z') }) as { commentId: number };
    await queue.transition({ github: h.github, context, number: 11, commentId: queued.commentId, status: 'running' });
    await queue.transition({ github: h.github, context, number: 11, commentId: queued.commentId, status: 'completed' });
    expect(await queue.listWaiting({ github: h.github, context })).toHaveLength(0);
    await expect(queue.transition({ github: h.github, context, number: 11, commentId: queued.commentId, status: 'running' }))
      .rejects.toThrow('不能从 completed 转为 running');
    const stored = h.comments.get(11)?.[0]?.body;
    expect(queue.decodeRequest(stored ?? '')).toMatchObject({ id: 'evt-1', status: 'completed' });
  });

  it('并发重复投递即使产生重复记录，也只保留一个待执行事件', async () => {
    const h = fixture();
    const event = request('same-delivery', 11, '2026-11-08T10:01:00Z');
    await Promise.all([
      queue.enqueue({ github: h.github, context, request: event }),
      queue.enqueue({ github: h.github, context, request: event }),
    ]);
    const waiting = await queue.listWaiting({ github: h.github, context });
    expect(waiting).toHaveLength(1);
    await queue.transition({ github: h.github, context, number: 11, commentId: waiting[0]!.commentId, status: 'running' });
    await queue.transition({ github: h.github, context, number: 11, commentId: waiting[0]!.commentId, status: 'completed' });
    expect(await queue.listWaiting({ github: h.github, context })).toHaveLength(0);
  });

  it('拒绝将凭据字段写入持久队列', async () => {
    const h = fixture();
    await expect(queue.enqueue({
      github: h.github, context,
      request: { ...request('unsafe', 11, '2026-11-08T10:01:00Z'), inputs: { access_token: 'must-not-persist' } },
    })).rejects.toThrow('包含敏感字段');
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('下一项在前一项完成后入队时仍会出现在下一次领取结果中', async () => {
    const h = fixture();
    const first = await queue.enqueue({ github: h.github, context, request: request('evt-1', 11, '2026-11-08T10:01:00Z') }) as { commentId: number };
    await queue.transition({ github: h.github, context, number: 11, commentId: first.commentId, status: 'running' });
    await queue.transition({ github: h.github, context, number: 11, commentId: first.commentId, status: 'completed' });
    await queue.enqueue({ github: h.github, context, request: request('evt-2', 12, '2026-11-08T10:02:00Z', 'review', 'agent-review.yml') });
    expect((await queue.listWaiting({ github: h.github, context })).map((entry) => entry.request.id)).toEqual(['evt-2']);
  });

  it('分发前因授权撤销、来源关闭或 PR SHA 变化而取消', async () => {
    const source = { state: 'open', labels: [{ name: 'agent:review' }], pull_request: {} };
    const github = {
      rest: {
        issues: { get: vi.fn(async () => ({ data: source })) },
        pulls: {
          get: vi.fn(async () => ({ data: { head: { sha: 'new-sha', repo: { full_name: 'org/project' } } } })),
        },
      },
    };
    const req = { number: 90, inputs: { authorization_label: 'agent:review', expected_head_sha: 'old-sha' } };
    await expect(worker.stillAuthorized(github, context, req)).resolves.toBe('PR 分支已更新，请重新添加执行标签');
    source.labels = [];
    await expect(worker.stillAuthorized(github, context, req)).resolves.toBe('授权标签已移除');
    source.state = 'closed';
    await expect(worker.stillAuthorized(github, context, req)).resolves.toBe('来源 Issue/PR 已关闭');
  });

  it('认证 Secret 指纹变化后才恢复暂停的请求，且指纹不保存明文', async () => {
    const h = fixture();
    const pending = await queue.enqueue({ github: h.github, context, request: request('evt-2', 12, '2026-11-08T10:02:00Z') }) as { commentId: number };
    vi.stubEnv('CODEX_AUTH_JSON', 'credential-old');
    vi.stubEnv('CODEX_AUTH_STORE_PAT', 'store-old');
    const oldFingerprint = worker.authFingerprint();
    await queue.transition({
      github: h.github, context, number: 12, commentId: pending.commentId,
      status: 'paused', authFingerprint: oldFingerprint, reason: '认证回存失败',
    });
    expect(await queue.listWaiting({ github: h.github, context })).toHaveLength(0);
    vi.stubEnv('CODEX_AUTH_JSON', 'credential-new');
    const newFingerprint = worker.authFingerprint();
    expect(newFingerprint).not.toBe(oldFingerprint);
    await queue.transition({ github: h.github, context, number: 12, commentId: pending.commentId, status: 'waiting' });
    expect((await queue.listWaiting({ github: h.github, context })).map((entry) => entry.request.id)).toEqual(['evt-2']);
    expect([...h.comments.values()].flat().map((comment) => comment.body).join('\n')).not.toContain('credential-new');
  });

  it('调度中断后按关联 run 结论恢复状态，不重放已完成模型任务', async () => {
    const h = fixture();
    const requestEntry = await queue.enqueue({ github: h.github, context, request: request('evt-running', 11, '2026-11-08T10:01:00Z') }) as { commentId: number };
    await queue.transition({ github: h.github, context, number: 11, commentId: requestEntry.commentId, status: 'running' });
    const running = [...h.comments.values()].flat().find((comment) => comment.id === requestEntry.commentId)!;
    const payload = queue.decodeRequest(running.body) as Record<string, unknown>;
    const encoded = Buffer.from(JSON.stringify({ ...payload, runId: 991, runUrl: 'https://github.com/org/project/actions/runs/991' })).toString('base64');
    h.comments.set(11, [{ ...running, body: running.body.replace(/<!-- agent-subscription-queue:v1 [A-Za-z0-9+/=]+ -->/, `<!-- agent-subscription-queue:v1 ${encoded} -->`) }]);
    const github = {
      ...h.github,
      rest: {
        ...h.github.rest,
        actions: { getWorkflowRun: vi.fn(async () => ({ data: { status: 'completed', conclusion: 'success', html_url: 'https://github.com/org/project/actions/runs/991', id: 991 } })) },
      },
    };
    await expect(worker.recoverRunning(github, context)).resolves.toBe(false);
    expect(await queue.listWaiting({ github: h.github, context })).toHaveLength(0);
    expect(queue.decodeRequest(h.comments.get(11)![0]!.body)).toMatchObject({ status: 'completed', runId: 991 });
  });

  it('所有订阅入口都由持有仓库级锁的队列分发', () => {
    const coordinator = readFileSync(new URL('../.github/workflows/agent-queue.yml', import.meta.url), 'utf8');
    expect(coordinator).toContain('group: codex-subscription-${{ github.repository }}');
    expect(coordinator).toContain("cron: '*/5 * * * *'");
    for (const name of [
      'agent-implement.yml', 'agent-implement-pr.yml', 'agent-review.yml',
      'agent-update-branch.yml', 'agent-explore.yml', 'agent-to-issues.yml', 'agent-publish-tickets.yml',
    ]) {
      const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
      expect(workflow).toContain('queue_request_id');
      expect(workflow).toContain('./.github/actions/queue-authorization');
    }
    const authorization = readFileSync(new URL('../.github/actions/queue-authorization/action.yml', import.meta.url), 'utf8');
    expect(authorization).toContain("comment.user?.login === 'github-actions[bot]'");
    expect(authorization).toContain('String(request.runId) === String(context.runId)');
  });
});
