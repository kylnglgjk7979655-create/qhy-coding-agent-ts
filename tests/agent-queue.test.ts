import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { promote } = require('../.github/scripts/tasks.cjs');
const repo = { owner: 'owner', repo: 'repo' };
const context = { repo, eventName: 'issues', actor: 'maintainer', runId: 10,
  payload: { action: 'closed', repository: { private: true, default_branch: 'main' }, issue: { number: 1, state: 'closed', state_reason: 'completed' } } };
type Issue = { number: number; state: string; labels: string[]; title?: string };

function fixture() {
  const issues: Issue[] = [2, 3, 4].map((number) => ({ number, state: 'open', labels: ['agent:queued'] }));
  const dependencies = new Map([[2, [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED' }]],
    [3, [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED' }]],
    [4, [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED' }, { number: 5, state: 'OPEN', stateReason: '' }]]]);
  const dispatch = vi.fn().mockResolvedValue({});
  const github = {
    rest: {
      repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: 'write' } }) },
      issues: {
        listForRepo: 'issues', getLabel: vi.fn(), createComment: vi.fn(),
        get: vi.fn(async ({ issue_number }) => ({ data: issues.find((issue) => issue.number === issue_number) })),
        addLabels: vi.fn(async ({ issue_number, labels }) => { issues.find((issue) => issue.number === issue_number)!.labels.push(...labels); }),
        removeLabel: vi.fn(async ({ issue_number, name }) => {
          const issue = issues.find((item) => item.number === issue_number)!;
          issue.labels = issue.labels.filter((label) => label !== name);
        }),
      },
      pulls: { list: 'prs' }, actions: { createWorkflowDispatch: dispatch },
    },
    paginate: vi.fn(async (route, args) => route === 'issues' ? issues.filter((issue) => !args.labels || issue.labels.includes(args.labels)) : []),
    graphql: vi.fn(async (query: string, args) => {
      if (query.includes('blocking(')) return { repository: { issue: { blocking: { nodes: issues, pageInfo: { hasNextPage: false } } } } };
      if (query.includes('blockedBy')) return { repository: { issue: { blockedBy: { nodes: dependencies.get(args.number) ?? [], pageInfo: { hasNextPage: false } } } } };
      return { repository: { issue: { parent: { number: 100 } } } };
    }),
  };
  return { issues, dependencies, github, dispatch, core: { notice: vi.fn(), warning: vi.fn(), setFailed: vi.fn() } };
}
beforeEach(() => vi.stubEnv('CODEX_AUTH_SLOTS', '["CODEX_AUTH_JSON_A","CODEX_AUTH_JSON_B"]'));
afterEach(() => vi.unstubAllEnvs());

describe('原生依赖解除后晋级全部就绪任务', () => {
  it('子 Issue B、C 同时满足依赖就都派发，D 仍等待其他前置任务', async () => {
    const f = fixture();
    await promote({ github: f.github, context, core: f.core });
    expect(f.dispatch.mock.calls.map(([args]) => args.inputs.issue_number)).toEqual(['2', '3']);
    expect(f.issues[2]!.labels).toContain('agent:queued');
  });
  it('重复关闭事件不会重复派发已经领取的任务', async () => {
    const f = fixture();
    await promote({ github: f.github, context, core: f.core });
    await promote({ github: f.github, context, core: f.core });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('派发失败恢复 queued，允许下次事件重试，不阻止其他就绪任务', async () => {
    const f = fixture(); f.dispatch.mockRejectedValueOnce(new Error('temporary network failure'));
    await promote({ github: f.github, context, core: f.core });
    expect(f.issues[0]!.labels).toContain('agent:queued');
    expect(f.dispatch.mock.calls.map(([args]) => args.inputs.issue_number)).toEqual(['2', '3']);
    expect(f.core.setFailed).toHaveBeenCalled();
  });
  it('人工任务与 not_planned 的依赖不会运行', async () => {
    const f = fixture(); f.issues[0]!.labels.push('ready-for-human');
    f.dependencies.set(3, [{ number: 1, state: 'CLOSED', stateReason: 'NOT_PLANNED' }]);
    await promote({ github: f.github, context, core: f.core });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('单份认证只领取一个任务，其他任务保留 queued 等待释放', async () => {
    vi.stubEnv('CODEX_AUTH_SLOTS', '');
    const f = fixture();
    await promote({ github: f.github, context, core: f.core });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.issues[1]!.labels).toContain('agent:queued');
  });
  it('定时或手动扫描会启动零依赖任务，保留 bugfix 的入口', async () => {
    const f = fixture(); f.dependencies.set(2, []); f.issues[0]!.labels.push('agent:bugfix');
    await promote({ github: f.github, context: { ...context, eventName: 'workflow_dispatch' }, core: f.core });
    expect(f.dispatch.mock.calls[0]![0].inputs).toMatchObject({ issue_number: '2', mode: 'bugfix', auth_secret: 'CODEX_AUTH_JSON_A' });
    expect(f.dispatch.mock.calls[1]![0].inputs.auth_secret).toBe('CODEX_AUTH_JSON_B');
  });
});
