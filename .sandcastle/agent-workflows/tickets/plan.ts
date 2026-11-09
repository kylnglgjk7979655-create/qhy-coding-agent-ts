import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Comment, Issue } from './github.js';

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

export const ticketMarker = (plan: Plan, key: string): string => `<!-- agent-ticket:${plan.parent}:${digest(plan)}:${key} -->`;
