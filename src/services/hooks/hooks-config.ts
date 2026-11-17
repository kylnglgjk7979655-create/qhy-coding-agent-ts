import { z } from 'zod';

/** v1 只实现这 6 个生命周期事件；未知事件键在配置加载阶段拒绝。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** SessionStart 只有 startup 和 resume 两种来源；枚举保留扩展位。 */
export const SESSION_START_SOURCES = ['startup', 'resume'] as const;

export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

/** Hook 超时的统一上限；单个 Hook 可用 timeoutMs 在 (0, 600000] 内覆盖默认值。 */
export const MAX_HOOK_TIMEOUT_MS = 600_000;

/** 各事件未单独配置 timeoutMs 时使用的默认超时；UserPromptSubmit 需要尽快回到用户输入。 */
export const DEFAULT_HOOK_TIMEOUTS_MS: Record<HookEvent, number> = {
  SessionStart: 60_000,
  UserPromptSubmit: 10_000,
  PreToolUse: 60_000,
  PostToolUse: 60_000,
  PostToolUseFailure: 60_000,
  Stop: 60_000,
};

export function defaultHookTimeoutMs(event: HookEvent): number {
  return DEFAULT_HOOK_TIMEOUTS_MS[event];
}

const exactNamePattern = /^[A-Za-z0-9_]+$/u;

export type HookMatcher =
  | { readonly kind: 'all' }
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'list'; readonly names: readonly string[] }
  | { readonly kind: 'regex'; readonly pattern: RegExp };

/**
 * matcher 不是 glob：
 * - 纯字母数字下划线视为精确名称；
 * - 完全由精确名称组成的 `A|B` 视为名称列表；
 * - 空串、`*` 与省略匹配全部；
 * - 其余按 JS 正则解析，非法正则在加载阶段抛错。
 */
export function parseHookMatcher(matcher: string | undefined): HookMatcher {
  if (matcher === undefined || matcher === '' || matcher === '*') return { kind: 'all' };
  if (exactNamePattern.test(matcher)) return { kind: 'exact', name: matcher };
  if (matcher.includes('|')) {
    const names = matcher.split('|');
    if (names.every((name) => exactNamePattern.test(name))) return { kind: 'list', names };
  }
  // new RegExp 在加载阶段试编译；语法错误直接抛给配置校验转为 CONFIG_ERROR。
  return { kind: 'regex', pattern: new RegExp(matcher) };
}

/** 每个事件用于 matcher 过滤的 query 字段；没有 query 的事件不做 matcher 过滤。 */
const hookQueryFields: Record<HookEvent, 'tool_name' | 'source' | undefined> = {
  SessionStart: 'source',
  UserPromptSubmit: undefined,
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PostToolUseFailure: 'tool_name',
  Stop: undefined,
};

export function hookQueryField(event: HookEvent): 'tool_name' | 'source' | undefined {
  return hookQueryFields[event];
}

/** query 缺失表示该事件没有 matcher 过滤，任何 matcher（包括正则）都不会生效。 */
export function matchesHookMatcher(matcher: string | undefined, query: string | undefined): boolean {
  if (query === undefined) return true;
  const parsed = parseHookMatcher(matcher);
  switch (parsed.kind) {
    case 'all': return true;
    case 'exact': return parsed.name === query;
    case 'list': return parsed.names.includes(query);
    case 'regex': return parsed.pattern.test(query);
  }
}

export const hookCommandSchema = z.strictObject({
  // v1 只有 command 类型；type 必填，未知类型在加载阶段拒绝。
  type: z.literal('command'),
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().min(1).max(MAX_HOOK_TIMEOUT_MS).optional(),
});

export const hookMatcherGroupSchema = z.strictObject({
  // 省略和空串都表示匹配全部。
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema).min(1),
}).superRefine((group, ctx) => {
  if (group.matcher === undefined) return;
  try {
    parseHookMatcher(group.matcher);
  } catch {
    ctx.addIssue({ code: 'custom', path: ['matcher'], message: 'matcher 正则无效' });
  }
});

export const hooksConfigSchema = z.strictObject({
  SessionStart: z.array(hookMatcherGroupSchema).optional(),
  UserPromptSubmit: z.array(hookMatcherGroupSchema).optional(),
  PreToolUse: z.array(hookMatcherGroupSchema).optional(),
  PostToolUse: z.array(hookMatcherGroupSchema).optional(),
  PostToolUseFailure: z.array(hookMatcherGroupSchema).optional(),
  Stop: z.array(hookMatcherGroupSchema).optional(),
});

export type HookCommand = z.infer<typeof hookCommandSchema>;
export type HookMatcherGroup = z.infer<typeof hookMatcherGroupSchema>;
export type HooksConfig = z.infer<typeof hooksConfigSchema>;

/**
 * 合并两层 hooks：按事件拼接数组，并按“事件 + matcher + command + timeoutMs”完全相同的 Hook 去重。
 * 保留第一条（配置顺序即用户级 → 项目级 → 项目本地），重复项追加 warning 文本。
 */
export function mergeHookSettings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const event of HOOK_EVENTS) {
    if (!(event in base) && !(event in overlay)) continue;
    const baseGroups = Array.isArray(base[event]) ? base[event] as HookMatcherGroup[] : [];
    const overlayGroups = Array.isArray(overlay[event]) ? overlay[event] as HookMatcherGroup[] : [];
    result[event] = dedupeGroups(event, [...baseGroups, ...overlayGroups], warnings);
  }
  return result;
}

function dedupeGroups(event: HookEvent, groups: HookMatcherGroup[], warnings: string[]): HookMatcherGroup[] {
  const seen = new Set<string>();
  const result: HookMatcherGroup[] = [];
  for (const group of groups) {
    const hooks = group.hooks.filter((hook) => {
      const key = JSON.stringify([event, group.matcher ?? null, hook.command, hook.timeoutMs ?? null]);
      if (seen.has(key)) {
        const warning = `Hook 配置重复，已保留第一条：事件 ${event}。`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return false;
      }
      seen.add(key);
      return true;
    });
    // 一个组里的 Hook 全部被去重时整组移除，避免出现空的 hooks 数组。
    if (hooks.length > 0) result.push(hooks.length === group.hooks.length ? group : { ...group, hooks });
  }
  return result;
}