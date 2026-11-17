import { z } from 'zod';
import { runControlledProcess } from '../process/controlled-process.js';
import type { ToolErrorCode } from '../../tools/tool-registry.js';
import { defaultHookTimeoutMs, type HookCommand, type HookEvent, type SessionStartSource } from './hooks-config.js';

/** v1 Hook 协议版本；不写入 stdin，仅由 ADR 与后续兼容判断使用。 */
export const HOOK_PROTOCOL_VERSION = 1;

/** stdout 超过该字节数时终止整个 Hook 进程组，结果记为输出超限。 */
export const MAX_HOOK_STDOUT_BYTES = 1024 * 1024;
/** stderr 超过该字节数时截断并追加显式标记，继续读取丢弃剩余内容。 */
export const MAX_HOOK_STDERR_BYTES = 64 * 1024;
/** 所有进入模型上下文的 Hook 文本统一按该字符数截断。 */
export const MAX_HOOK_INJECT_CHARS = 8_000;

export type HookOutcome = 'success' | 'blocking' | 'non_blocking_error' | 'cancelled';
export type HookFailureKind = 'timeout' | 'spawn_error' | 'invalid_json' | 'output_limit' | 'exit_code' | 'invalid_updated_input';

/** 所有 Hook 共用的 stdin 基础字段；事件专有字段由调用方附加。 */
export interface HookInputBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  approval_mode: 'model' | 'human';
  hook_event_name: HookEvent;
}

export type HookInput = HookInputBase & Record<string, unknown>;

export interface SessionStartHookInput extends HookInput {
  hook_event_name: 'SessionStart';
  source: SessionStartSource;
}

/** 真实用户提交的原始文本；该事件没有 matcher query，配置 matcher 不参与过滤。 */
export interface UserPromptSubmitHookInput extends HookInput {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

/**
 * 子 Agent 的工具事件身份；主 Agent 的工具事件省略这两个字段。
 * session_id 与 transcript_path 仍指向父对话，便于 Hook 关联同一会话。
 */
export interface SubagentHookIdentity {
  agent_id?: string;
  agent_type?: string;
}

/** 工具输入使用 prepare 后的结果，即即将审批和执行的输入；调用标识用于关联后续工具事件。 */
export interface PreToolUseHookInput extends HookInput, SubagentHookIdentity {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

/** 成功工具调用之后的输入；tool_response 与返回给模型的成功信封一致。 */
export interface PostToolUseHookInput extends HookInput, SubagentHookIdentity {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: { is_error: false; output: unknown };
  tool_use_id: string;
}

/** 工具执行抛错后的输入；error_code 只取工具错误码枚举，v1 当前只会是 TOOL_EXECUTION_ERROR。 */
export interface PostToolUseFailureHookInput extends HookInput, SubagentHookIdentity {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  error: string;
  error_code: ToolErrorCode;
  tool_use_id: string;
}

/**
 * 最终回答产生后的输入；stop_hook_active 表示本次运行是否由 Stop 阻止后的续跑触发。
 * 第一次运行传 false；续跑结束后的第二次运行传 true，便于 Hook 避免重复阻止。
 */
export interface StopHookInput extends HookInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** v1 stdout JSON 字段；未知字段忽略，已知字段类型不符按无效 JSON 处理。 */
const hookOutputSchema = z.object({
  continue: z.boolean().optional(),
  /** 阻止紧随其后的自动续跑；与 continue:false 一样直接结束本轮。 */
  preventContinuation: z.boolean().optional(),
  suppressOutput: z.boolean().optional(),
  decision: z.literal('block').optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z.object({
    permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  }).optional(),
});

export type HookOutput = z.infer<typeof hookOutputSchema>;

export interface HookResult extends HookOutput {
  outcome: HookOutcome;
  failureKind?: HookFailureKind;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** stdout 是否作为 JSON 对象成功解析；成功时普通 stdout 不再作为附加上下文。 */
  stdoutIsJson: boolean;
}

export interface HookRunOptions {
  /** 固定为工作区，决定 Hook 的相对路径解析。 */
  cwd: string;
  /** 省略时继承 CLI 进程环境。 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 稳定 runner 接口：后续事件复用同一 stdin/退出码/stdout 契约。
 * 所有执行边界都转成结果数据，不抛业务异常；调用方按 outcome 决定阻止、注入或提示。
 */
export async function runCommandHook(
  hook: HookCommand,
  input: HookInput,
  options: HookRunOptions,
): Promise<HookResult> {
  const startedAt = performance.now();
  const result = await runControlledProcess('/bin/sh', ['-c', hook.command], {
    cwd: options.cwd,
    stdin: JSON.stringify(input),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? defaultHookTimeoutMs(input.hook_event_name),
    stdoutLimitBytes: MAX_HOOK_STDOUT_BYTES,
    stderrLimitBytes: MAX_HOOK_STDERR_BYTES,
    terminateOnStdoutLimit: true,
    // Hook 必须同步结束：直接子进程退出后回收后台孙进程并关闭管道，避免继承管道导致挂起。
    reapOnExit: true,
  });
  const stderr = result.stderrTruncated ? `${result.stderr}\n[hook stderr 已截断]` : result.stderr;
  const base: HookResult = {
    outcome: 'success',
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: result.stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutIsJson: false,
  };

  // 顺序决定诊断优先级：用户取消必须与 Hook 自身超时区分开。
  if (result.cancelled) return { ...base, outcome: 'cancelled' };
  if (result.timedOut) return { ...base, outcome: 'non_blocking_error', failureKind: 'timeout' };
  if (result.startFailed) return { ...base, outcome: 'non_blocking_error', failureKind: 'spawn_error' };
  if (result.stdoutTruncated) return { ...base, outcome: 'non_blocking_error', failureKind: 'output_limit' };
  if (result.exitCode === 2) {
    return { ...base, outcome: 'blocking', reason: base.stderr.trim() || 'Hook 请求阻止该事件。' };
  }
  if (result.exitCode !== 0) return { ...base, outcome: 'non_blocking_error', failureKind: 'exit_code' };

  const stdout = result.stdout.trim();
  // 许多合法 Hook 不读取 stdin（只写文件或输出固定文本），进程退出时写入可能收到 EPIPE。
  // 只要 Hook 仍产出了输出或明确退出码，就不能把这种竞态改判为故障；
  // 只有退出 0 但完全没有输出时，才把 EPIPE 记为 spawn_error。
  // stdin 错误本身由运行器转换，不会升级为未处理的进程异常。
  if (stdout === '' && result.stdinFailed) {
    return { ...base, outcome: 'non_blocking_error', failureKind: 'spawn_error' };
  }
  if (!stdout.startsWith('{')) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ...base, outcome: 'non_blocking_error', failureKind: 'invalid_json' };
  }
  const output = hookOutputSchema.safeParse(parsed);
  if (!output.success) return { ...base, outcome: 'non_blocking_error', failureKind: 'invalid_json' };
  return { ...base, ...output.data, stdoutIsJson: true };
}

/** 按 Unicode 字符数截断，并保留显式标记；标记不占用注入上限。 */
export function truncateHookText(text: string, maxChars = MAX_HOOK_INJECT_CHARS): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars).join('')}\n[hook 内容已截断：超过 ${maxChars} 字符]`;
}