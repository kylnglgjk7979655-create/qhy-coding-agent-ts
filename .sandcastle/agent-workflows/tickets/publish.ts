import { parsePlan, sourceHash, ticketMarker, digest } from './plan.js';
import { GitHub, hasLabel } from './github.js';
import type { Plan } from './plan.js';
import type { Issue } from './github.js';

export function publishTickets(github: GitHub, input: Plan): Map<string, Issue> {
  const plan = parsePlan(input);
  const parent = github.issue(plan.parent);
  if (parent.state !== 'open' || !hasLabel(parent, 'agent:publish-tickets')) throw new Error('父 Issue 已关闭或发布标签已移除。');
  if (sourceHash(parent, github.comments(parent.number)) !== plan.source_hash) throw new Error('规格或人工评论已变化，请重新拆票和审批。');
  if (github.parent(parent.number) !== null) throw new Error('拆票来源必须为顶层父 Issue。');

  // 用完整列表找回“创建成功但尚未来得及挂接”的票，避免搜索索引延迟和重试重复创建。
  const existing = github.issues('state=all');
  const mapping = new Map<string, Issue>();
  for (const ticket of plan.tickets) {
    const matches = existing.filter((issue) => issue.user.login === 'github-actions[bot]' && issue.body.startsWith(ticketMarker(plan, ticket.key)));
    if (matches.length > 1) throw new Error(`票 ${ticket.key} 有多个发布副本，需人工处理。`);
    if (matches[0]) mapping.set(ticket.key, matches[0]);
  }
  const children = github.children(parent.number);
  if (children.some((child) => ![...mapping.values()].some((issue) => issue.id === child.id))) {
    throw new Error('父 Issue 已有其他计划或人工创建的子 Issue，拒绝混合发布。');
  }
  // 在任何写入前校验可恢复票的父关系与原生依赖 API，读失败不当作空依赖。
  for (const issue of mapping.values()) {
    const attached = github.parent(issue.number);
    if (attached !== null && attached !== parent.number) throw new Error('已有票属于其他父 Issue。');
    github.blockers(issue.number);
  }

  for (const ticket of plan.tickets) {
    let issue = mapping.get(ticket.key);
    if (!issue) {
      issue = github.api<Issue>('POST', 'issues', {
        title: ticket.title,
        body: [ticketMarker(plan, ticket.key), '## Parent', '', `#${parent.number}`, '', ticket.body].join('\n'),
        labels: ['ready-for-agent'],
      });
      mapping.set(ticket.key, issue);
    }
    if (!children.some((child) => child.id === issue.id)) {
      github.api('POST', `issues/${parent.number}/sub_issues`, { sub_issue_id: issue.id });
    }
    const blockers = github.blockers(issue.number);
    for (const key of ticket.blocked_by) {
      const blocker = mapping.get(key);
      if (!blocker) throw new Error(`缺失已发布的前置票：${key}`);
      if (!blockers.some((entry) => entry.id === blocker.id)) {
        github.api('POST', `issues/${issue.number}/dependencies/blocked_by`, { issue_id: blocker.id });
      }
    }
  }
  const marker = `<!-- agent-tickets-published:${digest(plan)} -->`;
  if (!github.comments(parent.number).some((comment) => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(marker))) {
    github.comment(parent.number, [marker, '## 子任务已发布', '',
      ...plan.tickets.map((ticket) => `- #${mapping.get(ticket.key)?.number} ${ticket.title}；前置：${ticket.blocked_by.map((key) => `#${mapping.get(key)?.number}`).join('、') || '无'}`),
      '', '已设置原生父子关系和阻塞依赖。添加父 Issue 的 `agent:implement` 后按依赖逐票实现；发布本身不启动实现。',
    ].join('\n'));
  }
  github.removeLabel(parent, 'agent:publish-tickets');
  return mapping;
}
