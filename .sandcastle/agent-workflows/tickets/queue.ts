import { GitHub, hasLabel } from './github.js';
import type { Issue } from './github.js';
import { PLAN_MARKER } from './plan.js';

interface Pull {
  number: number; body: string | null; base: { ref: string }; head?: { ref: string; repo?: { full_name: string } }; draft?: boolean; labels?: { name: string }[];
}
export const closesIssue = (body: string, number: number): boolean =>
  new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, 'iu').test(body);
export const completed = (issue: Issue): boolean => issue.state === 'closed' && issue.state_reason === 'completed';
const paused = (issue: Issue): boolean => issue.state !== 'open'
  || ['agent:blocked', 'agent:to-issues', 'agent:publish-tickets'].some((label) => hasLabel(issue, label));

export class Queue {
  private readonly pulls: Pull[];
  constructor(private readonly github: GitHub, private readonly dispatch?: GitHub) {
    this.pulls = github.list<Pull>('pulls?state=open');
  }

  private hasPull(number: number, parent?: number | null): boolean {
    return this.pulls.some((pull) => closesIssue(pull.body ?? '', number)
      && !(parent != null && pull.head?.ref === `agent/parent-${parent}` && pull.head.repo?.full_name === this.github.repo && pull.base.ref === 'main'));
  }

  private dependenciesDone(number: number): boolean {
    const parent = this.github.parent(number);
    return this.github.blockers(number).every((issue) => completed(issue) && !this.hasPull(issue.number, parent));
  }

  private eligible(issue: Issue, parent?: number | null): boolean {
    return issue.state === 'open' && !hasLabel(issue, 'agent:blocked')
      && !hasLabel(issue, 'agent:in-progress') && !this.hasPull(issue.number, parent)
      && this.dependenciesDone(issue.number);
  }

  /** 只选择，不启动模型；每个父需求最多一个活动子任务。 */
  select(root: Issue): Issue | undefined {
    if (!this.eligible(root)) return undefined;
    const children = this.github.children(root.number);
    if (!children.length) return root;
    if (children.some((child) => hasLabel(child, 'agent:in-progress') || this.hasPull(child.number, root.number))) return undefined;
    for (const child of children.sort((a, b) => a.number - b.number)) {
      if (this.github.children(child.number).length) throw new Error('暂不支持嵌套父 Issue。');
      if (this.eligible(child, root.number)) return child;
    }
    return undefined;
  }

  /** 标签入口授权父需求的全部直接子票，或者一个独立/子 Issue。 */
  prepare(number: number): { issue?: Issue; parent?: number } {
    const source = this.github.issue(number);
    if (!hasLabel(source, 'agent:implement')) return {};
    if (source.state !== 'open') {
      this.github.removeLabel(source, 'agent:implement');
      return {};
    }
    // 人工重加 implement 是失败重试授权，队列扫描本身不会移除 blocked。
    this.github.removeLabel(source, 'agent:blocked');
    this.github.removeLabel(source, 'agent:in-progress');
    const fresh = this.github.issue(number);
    const children = this.github.children(number);
    const parent = this.github.parent(number);
    if (['agent:to-issues', 'agent:publish-tickets'].some((label) => hasLabel(fresh, label))
      || (!children.length && this.github.comments(number).some((comment) => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(PLAN_MARKER)))) {
      throw new Error('拆票计划尚未完成审批发布，拒绝直接实现整份规格。');
    }
    if (parent !== null && children.length) throw new Error('暂不支持嵌套父 Issue。');
    if (parent !== null) {
      const ancestor = this.github.issue(parent);
      if (paused(ancestor) || !this.dependenciesDone(parent)) {
        this.github.addLabels(number, ['agent:queued']);
        this.github.removeLabel(fresh, 'agent:implement');
        return {};
      }
      const siblings = this.github.children(parent);
      if (siblings.some((sibling) => sibling.number !== number
        && (hasLabel(sibling, 'agent:in-progress') || this.hasPull(sibling.number, parent)))) {
        this.github.addLabels(number, ['agent:queued']);
        this.github.removeLabel(fresh, 'agent:implement');
        return {};
      }
    }
    const selected = parent !== null ? (this.eligible(fresh, parent) ? fresh : undefined) : this.select(fresh);
    this.github.removeLabel(fresh, 'agent:implement');
    if (children.length) {
      this.github.addLabels(number, ['agent:queued']);
    }
    if (!selected) {
      if (!this.hasPull(number)) this.github.addLabels(number, ['agent:queued']);
      return {};
    }
    this.github.removeLabel(this.github.issue(selected.number), 'agent:queued');
    this.github.addLabels(selected.number, ['agent:in-progress']);
    return { issue: selected, ...(children.length ? { parent: number } : parent === null ? {} : { parent }) };
  }

  /** 扫描所有持久化 queued 标签；一次仅发出一个模型入口，避免订阅并发组覆盖待运行任务。 */
  promote(): number | undefined {
    const queued = [...new Map([
      ...this.github.issues('state=open&labels=agent%3Aqueued'),
      ...this.github.issues('state=open&labels=agent%3Aimplement'),
    ].map((issue) => [issue.number, issue])).values()];
    const roots = new Set(queued.map((issue) => issue.number));
    for (const root of queued.sort((a, b) => a.number - b.number)) {
      if (hasLabel(root, 'agent:blocked') || hasLabel(root, 'agent:in-progress')) continue;
      const parent = this.github.parent(root.number);
      if (parent !== null) {
        if (roots.has(parent)) continue;
        const ancestor = this.github.issue(parent);
        if (paused(ancestor) || !this.dependenciesDone(parent)) continue;
        if (this.github.children(parent).some((sibling) => sibling.number !== root.number
          && (this.hasPull(sibling.number, parent) || hasLabel(sibling, 'agent:in-progress')))) continue;
      }
      const children = this.github.children(root.number);
      if (children.length && this.dependenciesDone(root.number) && children.every((child) => completed(child) && !this.hasPull(child.number, root.number))) {
        const shared = this.pulls.find((pull) => pull.head?.ref === `agent/parent-${root.number}`
          && pull.head.repo?.full_name === this.github.repo && pull.base.ref === 'main');
        if (shared?.draft && !shared.labels?.some((label) => label.name === 'agent:blocked')) {
          const writer = this.dispatch ?? this.github;
          if (this.dispatch && shared.labels?.some((label) => label.name === 'agent:review')) {
            writer.removeLabel({ ...root, number: shared.number, labels: shared.labels }, 'agent:review');
          }
          writer.addLabels(shared.number, ['agent:review']);
          if (!this.dispatch) {
            this.github.api('POST', 'actions/workflows/check.yml/dispatches', { ref: shared.head!.ref });
            this.github.api('POST', 'actions/workflows/agent-review.yml/dispatches', {
              ref: 'main', inputs: { pr_number: String(shared.number) },
            });
          }
        }
        this.github.removeLabel(root, 'agent:queued');
        const marker = '<!-- agent-queue-complete -->';
        if (!this.github.comments(root.number).some((comment) => comment.body.startsWith(marker) && comment.user.login === 'github-actions[bot]')) {
          this.github.comment(root.number, `${marker}\n所有子任务已完成，父 Issue 保持开放，等待维护者验收。`);
        }
        continue;
      }
      if (parent !== null ? this.eligible(root, parent) : this.select(root)) {
        // 对被 GitHub 单待运行槽替换掉的事件，重新贴标恢复执行。
        const writer = this.dispatch ?? this.github;
        writer.removeLabel(root, 'agent:implement');
        writer.addLabels(root.number, ['agent:implement']);
        if (!this.dispatch) {
          this.github.api('POST', 'actions/workflows/agent-implement.yml/dispatches', {
            ref: 'main', inputs: { issue_number: String(root.number) },
          });
        }
        return root.number;
      }
    }
    return undefined;
  }

  verify(number: number): void {
    const issue = this.github.issue(number);
    const parent = this.github.parent(number);
    if (issue.state !== 'open' || !hasLabel(issue, 'agent:in-progress') || !this.dependenciesDone(number)) {
      throw new Error('任务已关闭、取消或前置依赖重新打开，拒绝推送。');
    }
    if (parent !== null) {
      const root = this.github.issue(parent);
      if (paused(root) || !this.dependenciesDone(parent)) {
        throw new Error('父需求已停止或依赖重新打开，拒绝推送。');
      }
    }
  }
}

export function hasModelRun(github: GitHub): boolean {
  const paths = new Set(['agent-implement.yml', 'agent-review.yml', 'agent-implement-pr.yml', 'agent-update-branch.yml', 'agent-explore.yml', 'agent-to-issues.yml']);
  for (const status of ['in_progress', 'queued', 'pending', 'waiting']) {
    const runs = github.api<{ workflow_runs: { path: string }[] }>('GET', `actions/runs?status=${status}&per_page=100`).workflow_runs;
    if (runs.some((run) => paths.has(run.path.split('/').at(-1) ?? ''))) return true;
  }
  return false;
}
