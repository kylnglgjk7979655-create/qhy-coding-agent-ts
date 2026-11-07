import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Comment, Issue } from './github.js';

export const PLAN_MARKER = '<!-- agent-ticket-plan:v1 -->';
const ticketSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(15_000),
  blocked_by: z.array(z.string()).max(50),
}).strict();
const planSchema = z.object({
  version: z.literal(1), parent: z.number().int().positive(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  tickets: z.array(ticketSchema).min(1).max(50),
}).strict();
export type Plan = z.infer<typeof planSchema>;
const draftSchema = z.object({ slices: z.array(z.object({
  key: ticketSchema.shape.key, title: ticketSchema.shape.title,
  whatToBuild: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  blockedBy: ticketSchema.shape.blocked_by,
}).strict()).min(1).max(50) }).strict();

export function planFromDraft(value: unknown, parent: number, source_hash: string): Plan {
  const draft = draftSchema.parse(value);
  return parsePlan({ version: 1, parent, source_hash, tickets: draft.slices.map((slice) => ({
    key: slice.key, title: slice.title, blocked_by: slice.blockedBy,
    body: `## What to build\n\n${slice.whatToBuild}\n\n## Acceptance criteria\n\n${slice.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join('\n')}`,
  })) });
}
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceHash = (issue: Issue, comments: Comment[]): string => digest({
  number: issue.number, title: issue.title, body: issue.body,
  comments: comments.filter((comment) => comment.user.type !== 'Bot').map(({ id, body }) => ({ id, body })),
});

export function parsePlan(value: unknown): Plan {
  const plan = planSchema.parse(value);
  const seen = new Set<string>();
  for (const ticket of plan.tickets) {
    if (/\b(?:closes|fixes|resolves)\s+#\d+/iu.test(ticket.body)) throw new Error('票正文不得包含 Closes 指令。');
    if (seen.has(ticket.key)) throw new Error(`重复票标识：${ticket.key}`);
    if (new Set(ticket.blocked_by).size !== ticket.blocked_by.length) throw new Error('阻塞关系重复。');
    // 强制按拓扑顺序输出；同时拒绝缺失引用、自依赖和循环。
    for (const key of ticket.blocked_by) {
      if (!seen.has(key)) throw new Error(`${ticket.key} 的前置 ${key} 不存在或未排在它之前。`);
    }
    seen.add(ticket.key);
  }
  return plan;
}

export function renderPlan(plan: Plan): string {
  const body = [PLAN_MARKER, '## 待审批的拆票计划', '',
    '请检查粒度、验收标准及阻塞关系。确认后添加 `agent:publish-tickets`；需要修改时留言并重新添加 `agent:to-issues`。',
    '发布只创建子 Issue 和依赖；发布后给父 Issue 添加 `agent:implement` 才授权执行。', '',
    ...plan.tickets.flatMap((ticket, index) => [
      `### ${index + 1}. ${ticket.title}`, '',
      `标识：\`${ticket.key}\`；阻塞于：${ticket.blocked_by.map((key) => `\`${key}\``).join('、') || '无'}。`, '', ticket.body, '',
    ]),
    '<details><summary>机器可读计划（修改计划请重新生成）</summary>', '',
    '```json', JSON.stringify(plan, null, 2), '```', '', '</details>',
  ].join('\n');
  if (body.length > 60_000) throw new Error('计划超出单条 GitHub 评论长度，请减少票数或正文。');
  return body;
}

export function approvedPlan(comments: Comment[], approvedAt: string): Plan {
  const cutoff = Date.parse(approvedAt);
  if (!Number.isFinite(cutoff)) throw new Error('缺少审批事件时间，拒绝发布。');
  const comment = comments.filter((entry) => entry.user.login === 'github-actions[bot]'
    && entry.body.startsWith(PLAN_MARKER) && Date.parse(entry.created_at) <= cutoff)
    .sort((a, b) => b.id - a.id)[0];
  if (!comment) throw new Error('审批时没有可用的机器人拆票计划，请先添加 agent:to-issues。');
  if (Date.parse(comment.updated_at) > cutoff) throw new Error('计划在审批后发生修改，请重新审核并添加发布标签。');
  const heading = '<details><summary>机器可读计划（修改计划请重新生成）</summary>\n\n';
  const start = comment.body.lastIndexOf(heading);
  const json = start < 0 ? undefined : /^```json\n([\s\S]*)\n```\n\n<\/details>$/u.exec(comment.body.slice(start + heading.length))?.[1];
  if (!json) throw new Error('计划 JSON 缺失。');
  return parsePlan(JSON.parse(json));
}

export const ticketMarker = (plan: Plan, key: string): string => `<!-- agent-ticket:${plan.parent}:${digest(plan)}:${key} -->`;
