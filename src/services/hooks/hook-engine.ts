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

/**
 * 按工具结果在消息中的顺序消费 PostToolUse / PostToolUseFailure 结果，生成隐藏反馈消息。
 * 找不到对应工具结果时仍按暂存顺序追加，避免反馈丢失；每次都清空暂存。
 * 主 Agent 与子 Agent 共用该顺序，保证反馈总排在整批工具结果之后。
 */
export function takeToolFeedbackMessages(
  messages: readonly ModelMessage[],
  pending: Map<string, HookEventResult>,
  tracker: HookInjectionTracker,
): ModelMessage[] {
  const feedback: ModelMessage[] = [];
  const emitted = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || emitted.has(part.toolCallId)) continue;
      const result = pending.get(part.toolCallId);
      if (result === undefined) continue;
      emitted.add(part.toolCallId);
      feedback.push(...toolEventFeedbackMessages(result, tracker));
    }
  }
  for (const [callId, result] of pending) {
    if (!emitted.has(callId)) feedback.push(...toolEventFeedbackMessages(result, tracker));
  }
  pending.clear();
  return feedback;
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

/** PreToolUse 的权限结论；deny 在审批前短路，allow/ask 继续经过权限策略。 */
export interface PreToolUseDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/** PreToolUse 的聚合结果；updatedInput 与权限结论相互独立，deny 时不保留改写。 */
export interface PreToolUseEvaluation {
  decision?: PreToolUseDecision;
  /** 已通过工具 inputSchema 校验的改写；按配置顺序取最后一个有效结果。 */
  updatedInput?: unknown;
  /** 配置顺序不变；updatedInput 校验失败的运行已改为 non_blocking_error。 */
  runs: HookCommandRun[];
}

const PRE_TOOL_USE_PRECEDENCE: Record<PreToolUseDecision['decision'], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * 聚合所有匹配 Hook 的 PreToolUse 结论：deny > ask > allow，同结论取配置顺序中的第一条。
 * updatedInput 先经工具 inputSchema 校验；校验失败只把该运行记为 non_blocking_error，
 * 并忽略其权限结论。有效改写按配置顺序覆盖，最后一个用于审批与执行；deny 优先于改写。
 * 故障、超时和不带权限结论的成功输出不参与聚合；调用方仍按现有工具错误码返回结果。
 */
export async function evaluatePreToolUse(
  result: HookEventResult,
  validateInput?: (value: unknown) => boolean | Promise<boolean>,
): Promise<PreToolUseEvaluation> {
  let selected: PreToolUseDecision | undefined;
  let updatedInput: unknown;
  const runs: HookCommandRun[] = [];
  for (const run of result.runs) {
    const candidate = run.result.outcome === 'success'
      ? run.result.hookSpecificOutput?.updatedInput
      : undefined;
    if (candidate !== undefined && validateInput !== undefined && !await validateInput(candidate)) {
      runs.push({
        ...run,
        result: { ...run.result, outcome: 'non_blocking_error', failureKind: 'invalid_updated_input' },
      });
      continue;
    }
    runs.push(run);
    if (candidate !== undefined) updatedInput = candidate;
    const decision = preToolUseRunDecision(run.result);
    if (decision === undefined) continue;
    if (selected === undefined
      || PRE_TOOL_USE_PRECEDENCE[decision.decision] > PRE_TOOL_USE_PRECEDENCE[selected.decision]) {
      selected = decision;
    }
  }
  // deny 先于任何改写生效；不把改写结果交给审批或执行。
  if (selected?.decision === 'deny') return { decision: selected, runs };
  return {
    ...(selected === undefined ? {} : { decision: selected }),
    ...(updatedInput === undefined ? {} : { updatedInput }),
    runs,
  };
}

function preToolUseRunDecision(result: HookResult): PreToolUseDecision | undefined {
  // exit 2 与顶层 decision block 都等价于 deny，理由来自 blocking reason。
  if (result.outcome === 'blocking') return denyDecision(result.reason);
  if (result.outcome !== 'success') return undefined;
  if (result.decision === 'block') return denyDecision(result.reason);
  const decision = result.hookSpecificOutput?.permissionDecision;
  if (decision === undefined) return undefined;
  const reason = result.hookSpecificOutput?.permissionDecisionReason;
  return { decision, ...(reason === undefined ? {} : { reason }) };
}

function denyDecision(reason: string | undefined): PreToolUseDecision {
  return { decision: 'deny', ...(reason === undefined ? {} : { reason }) };
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

/**
 * 工具事件（PostToolUse / PostToolUseFailure）的反馈消息：
 * exit 2 / decision block 的理由与 additionalContext 都只作为反馈。
 * 普通 stdout 只进日志；反馈不改变已经返回给模型的工具结果，也不撤销副作用。
 */
export function toolEventFeedbackMessages(
  result: HookEventResult,
  tracker: HookInjectionTracker,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const run of result.runs) {
    if (!tracker.claim(run.runId)) continue;
    const feedback = toolEventFeedback(run.result);
    if (feedback === undefined || feedback.trim().length === 0) continue;
    messages.push({
      role: 'user',
      content: `<hook-feedback event="${run.event}" hook="${run.event}:${run.order}">\n${truncateHookText(feedback)}\n</hook-feedback>`,
    });
  }
  return messages;
}

function toolEventFeedback(result: HookResult): string | undefined {
  const parts: string[] = [];
  if (result.outcome === 'blocking') {
    parts.push(result.reason ?? 'Hook 请求阻止该事件。');
  } else if (result.outcome === 'success') {
    if (result.decision === 'block') parts.push(result.reason ?? 'Hook 请求阻止该事件。');
    const context = result.hookSpecificOutput?.additionalContext;
    if (context !== undefined) parts.push(context);
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

/**
 * Stop 是否请求在同一轮次内续跑：exit 2 或 decision block 请求续跑。
 * 任一 Hook 返回 continue:false 或 preventContinuation:true 都直接结束，不再续跑；
 * 没有阻止结论时也不续跑。
 */
export function stopContinuation(result: HookEventResult): boolean {
  let requested = false;
  for (const run of result.runs) {
    const hookResult = run.result;
    if (hookResult.outcome === 'success'
      && (hookResult.continue === false || hookResult.preventContinuation === true)) {
      return false;
    }
    if (hookResult.outcome === 'blocking'
      || (hookResult.outcome === 'success' && hookResult.decision === 'block')) {
      requested = true;
    }
  }
  return requested;
}

/**
 * Stop 的隐藏反馈：只有 exit 2 与 decision block 的理由进入有效历史。
 * 该事件没有 matcher query；反馈排在最终回答之后，供后续请求可见。
 */
export function stopFeedbackMessages(
  result: HookEventResult,
  tracker: HookInjectionTracker,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const run of result.runs) {
    if (!tracker.claim(run.runId)) continue;
    const reason = stopFeedback(run.result);
    if (reason === undefined || reason.trim().length === 0) continue;
    messages.push({
      role: 'user',
      content: `<hook-feedback event="Stop" hook="Stop:${run.order}">\n${truncateHookText(reason)}\n</hook-feedback>`,
    });
  }
  return messages;
}

function stopFeedback(result: HookResult): string | undefined {
  if (result.outcome === 'blocking') return result.reason ?? 'Hook 请求阻止结束本轮。';
  if (result.outcome === 'success' && result.decision === 'block') {
    return result.reason ?? 'Hook 请求阻止结束本轮。';
  }
  return undefined;
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
    case 'invalid_updated_input': return 'updatedInput 未通过工具参数校验';
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