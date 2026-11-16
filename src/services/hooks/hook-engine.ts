import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { hookQueryField, matchesHookMatcher, type HookCommand, type HookEvent, type HooksConfig } from './hooks-config.js';
import { runCommandHook, truncateHookText, type HookInput, type HookResult, type HookRunOptions } from './hook-runner.js';

/** UI 行最多展示的字符数，避免 Hook 的 systemMessage 刷屏。 */
export const MAX_HOOK_UI_LINE_CHARS = 500;

export interface SelectedHook {
  event: HookEvent;
  /** 配置顺序；结果与注入消息都按该顺序稳定排列。 */
  order: number;
  matcher: string | undefined;
  hook: HookCommand;
}

export interface HookCommandRun extends SelectedHook {
  /** 本次执行标识；注入去重只使用该标识，不扫描命令输出。 */
  runId: string;
  result: HookResult;
}

export interface HookEventResult {
  event: HookEvent;
  runs: HookCommandRun[];
}

/** 按配置顺序选出事件下所有匹配 matcher 的 Hook；无 query 的事件不做 matcher 过滤。 */
export function selectHooks(hooks: HooksConfig | undefined, event: HookEvent, query: string | undefined): SelectedHook[] {
  const selected: SelectedHook[] = [];
  for (const group of hooks?.[event] ?? []) {
    if (!matchesHookMatcher(group.matcher, query)) continue;
    for (const hook of group.hooks) {
      selected.push({ event, order: selected.length, matcher: group.matcher, hook });
    }
  }
  return selected;
}

/**
 * 并行执行匹配到的所有 Hook，并按配置顺序返回结果。
 * 每个 Hook 使用独立取消信号；任一 Hook 的超时或输出超限只影响自身。
 */
export async function runHookEvent(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  input: HookInput,
  options: HookRunOptions,
): Promise<HookEventResult> {
  const queryField = hookQueryField(event);
  const query = queryField === undefined ? undefined : input[queryField];
  const selected = selectHooks(hooks, event, typeof query === 'string' ? query : undefined);
  const runs = await Promise.all(selected.map(async (item) => {
    const controller = new AbortController();
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    const timeoutMs = item.hook.timeoutMs ?? options.timeoutMs;
    const result = await runCommandHook(item.hook, input, {
      ...options,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { ...item, runId: randomUUID(), result };
  }));
  return { event, runs };
}

/**
 * 进程内注入去重：每个 Hook 运行标识只允许注入一次。
 * 用 Set 而非扫描文本，因为 Hook 输出可能恰好包含运行标识。
 */
export class HookInjectionTracker {
  private readonly injected = new Set<string>();

  claim(runId: string): boolean {
    if (this.injected.has(runId)) return false;
    this.injected.add(runId);
    return true;
  }
}

/** SessionStart 的附加上下文：成功时取 JSON additionalContext 或普通 stdout，blocking 时取理由。 */
export function sessionStartContextMessages(
  result: HookEventResult,
  tracker: HookInjectionTracker,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const run of result.runs) {
    if (!tracker.claim(run.runId)) continue;
    const context = sessionStartContext(run.result);
    if (context === undefined || context.trim().length === 0) continue;
    messages.push({
      role: 'user',
      content: `<hook-context event="SessionStart">\n${truncateHookText(context)}\n</hook-context>`,
    });
  }
  return messages;
}

function sessionStartContext(result: HookResult): string | undefined {
  const context = successfulContext(result);
  if (context !== undefined) return context;
  // SessionStart 没有可阻止的启动动作；exit 2 的理由按反馈注入，启动继续。
  if (result.outcome === 'blocking') return result.reason;
  return undefined;
}

/** exit 0 时 JSON additionalContext 或普通 stdout 作为附加上下文；不能把其他 JSON 字段注入模型。 */
function successfulContext(result: HookResult): string | undefined {
  if (result.outcome !== 'success') return undefined;
  return result.stdoutIsJson ? result.hookSpecificOutput?.additionalContext : result.stdout;
}

/** UserPromptSubmit 的停止结论；block 丢弃原 prompt，stop（continue:false）保留原 prompt。 */
export interface UserPromptSubmitStop {
  kind: 'block' | 'stop';
  reason: string;
}

/**
 * 合并所有匹配 Hook 的停止结论：exit 2 与 decision block 优先于 continue false。
 * 只有 success 才可能携带 JSON 结论；故障与超时按协议只提示，不阻止本轮。
 */
export function userPromptSubmitStop(result: HookEventResult): UserPromptSubmitStop | undefined {
  let stop: UserPromptSubmitStop | undefined;
  for (const run of result.runs) {
    const hookResult = run.result;
    if (hookResult.outcome === 'blocking') {
      return { kind: 'block', reason: hookResult.reason ?? 'Hook 请求阻止本轮。' };
    }
    if (hookResult.outcome !== 'success') continue;
    if (hookResult.decision === 'block') {
      return { kind: 'block', reason: hookResult.reason ?? 'Hook 请求阻止本轮。' };
    }
    if (hookResult.continue === false && stop === undefined) {
      stop = { kind: 'stop', reason: hookResult.reason ?? 'Hook 请求停止本轮。' };
    }
  }
  return stop;
}

/** UserPromptSubmit 的附加上下文：仅成功运行的 additionalContext 或普通 stdout。 */
export function userPromptSubmitContextMessages(
  result: HookEventResult,
  tracker: HookInjectionTracker,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const run of result.runs) {
    if (!tracker.claim(run.runId)) continue;
    const context = successfulContext(run.result);
    if (context === undefined || context.trim().length === 0) continue;
    messages.push({
      role: 'user',
      content: `<hook-context event="UserPromptSubmit">\n${truncateHookText(context)}\n</hook-context>`,
    });
  }
  return messages;
}

/** 面向用户的提示文本；Hook 故障只提示不阻止，普通成功不产生噪声。 */
export function describeHookRun(run: HookCommandRun): string | undefined {
  switch (run.result.outcome) {
    case 'success':
      if (run.result.decision === 'block') {
        return `[hook] ${run.event}: ${truncateUiLine(run.result.reason ?? 'Hook 请求阻止该事件。')}`;
      }
      // continue:false 停止本轮；理由与 blocking 一样只给用户看。
      if (run.result.continue === false) {
        return `[hook] ${run.event}: ${truncateUiLine(run.result.reason ?? 'Hook 请求停止本轮。')}`;
      }
      return run.result.systemMessage === undefined
        ? undefined
        : `[hook] ${run.event}: ${truncateUiLine(run.result.systemMessage)}`;
    case 'blocking':
      return `[hook] ${run.event}: ${truncateUiLine(run.result.reason ?? 'Hook 请求阻止该事件。')}`;
    case 'cancelled':
      return `[hook] ${run.event}: 已取消`;
    case 'non_blocking_error':
      return `[hook] ${run.event}: ${failureDescription(run.result)}（已忽略，不影响对话）`;
    default:
      return undefined;
  }
}

function failureDescription(result: HookResult): string {
  switch (result.failureKind) {
    case 'timeout': return '执行超时';
    case 'spawn_error': return '启动失败';
    case 'invalid_json': return 'stdout JSON 无效';
    case 'output_limit': return 'stdout 超过 1 MiB，已终止';
    case 'exit_code': return `退出码 ${result.exitCode ?? '未知'}`;
    default: return '执行失败';
  }
}

function truncateUiLine(text: string): string {
  const characters = Array.from(text.replace(/[\r\n]+/gu, ' '));
  return characters.length <= MAX_HOOK_UI_LINE_CHARS
    ? characters.join('')
    : `${characters.slice(0, MAX_HOOK_UI_LINE_CHARS).join('')}…`;
}