import { GitHub, type Issue } from '../tickets/github.js';

/** 从原生父子关系构建整份需求；旧 PR 即使先写 Closes 子票，也能找到父需求。 */
export function fetchIssueContext(number: number, github: GitHub) {
  const rootNumber = github.parent(number) ?? number;
  const root = github.issue(rootNumber);
  const children = github.children(rootNumber);
  const describe = (issue: Issue): string => [
    `## #${issue.number} ${issue.title}`,
    `状态：${issue.state} / ${issue.state_reason ?? '未完成'}`,
    issue.body,
    '### 评论',
    JSON.stringify(github.comments(issue.number), null, 2),
  ].join('\n\n');
  return {
    issueNumber: String(root.number),
    issueTitle: root.title,
    linkedIssue: [
      children.length ? '# 父 PRD（整体需求与约束）' : '# Issue',
      describe(root),
      ...(children.length ? [
        '# 全部子任务',
        '逐票核对验收标准。completed 表示已交付；开放或 not_planned 的票不可当作已完成。',
        ...children.map(describe),
      ] : []),
    ].join('\n\n'),
  };
}
