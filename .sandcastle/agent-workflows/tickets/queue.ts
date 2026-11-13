import { GitHub, hasLabel } from './github.js';
import type { Issue } from './github.js';

interface Pull {
  number: number; body: string | null; base: { ref: string }; head?: { ref: string; repo?: { full_name: string } }; draft?: boolean; labels?: { name: string }[];
}
export const closesIssue = (body: string, number: number): boolean =>
  new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, 'iu').test(body);
export const completed = (issue: Issue): boolean => issue.state === 'closed' && issue.state_reason === 'completed';
const paused = (issue: Issue): boolean => issue.state !== 'open'
  || ['agent:blocked', 'agent:to-issues'].some((label) => hasLabel(issue, label));

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
    const children = this.github.children(root.number);
    // 父需求的共享 PR 现在关闭父票；它是交付容器，不阻塞本需求后续子票。
    if (!this.eligible(root, children.length ? root.number : undefined)) return undefined;
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
    // 人工重加 implement 是失败重试授权。
    this.github.removeLabel(source, 'agent:blocked');
    this.github.removeLabel(source, 'agent:in-progress');
    const fresh = this.github.issue(number);
    const children = this.github.children(number);
    const parent = this.github.parent(number);
    if (hasLabel(fresh, 'agent:to-issues')) throw new Error('拆票尚未完成，拒绝实现整份规格。');
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

  /** 当前置 Issue 完成时，只检查直接依赖它且已排队的任务。 */
  promote(blocker: number): number[] {
    if (!completed(this.github.issue(blocker))) return [];
    const promoted: number[] = [];
    for (const root of this.github.dependents(blocker).sort((a, b) => a.number - b.number)) {
      if (!hasLabel(root, 'agent:queued') || paused(root) || hasLabel(root, 'agent:in-progress')
        || hasLabel(root, 'agent:implement')) continue;
      const parent = this.github.parent(root.number);
      if (parent !== null) {
        const ancestor = this.github.issue(parent);
        if (hasLabel(ancestor, 'agent:queued') || paused(ancestor) || !this.dependenciesDone(parent)) continue;
        if (this.github.children(parent).some((sibling) => sibling.number !== root.number
          && (this.hasPull(sibling.number, parent) || hasLabel(sibling, 'agent:in-progress')))) continue;
      }
      if (!(parent !== null ? this.eligible(root, parent) : this.select(root))) continue;
      if (!this.dispatch) throw new Error('标签接续需要 AGENT_PAT。');
      this.dispatch.addLabels(root.number, ['agent:implement']);
      promoted.push(root.number);
    }
    return promoted;
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
