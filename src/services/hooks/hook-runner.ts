import { z } from 'zod';
import { runControlledProcess } from '../process/controlled-process.js';
import { defaultHookTimeoutMs, type HookCommand, type HookEvent, type SessionStartSource } from './hooks-config.js';

/** v1 Hook 协议版本；不写入 stdin，仅由 ADR 与后续兼容判断使用。 */
export const HOOK_PROTOCOL_VERSION = 1;

/** stdout 超过该字节数时终止整个 Hook 进程组，结果记为输出超限。 */
export const MAX_HOOK_STDOUT_BYTES = 1024 * 1024;
/** stderr 超过该字节数时截断并追加显式标记，继续读取丢弃剩余内容。 */
export const MAX_HOOK_STDERR_BYTES = 64 * 1024;
/** 所有进入模型上下文的 Hook 文本统一按该字符数截断。 */
export const MAX_HOOK_INJECT_CHARS = 8_000;
/** 旧版通用默认超时；现在按事件取 defaultHookTimeoutMs，保留该常量避免影响既有调用方。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export type HookOutcome = 'success' | 'blocking' | 'non_blocking_error' | 'cancelled';
export type HookFailureKind = 'timeout' | 'spawn_error' | 'invalid_json' | 'output_limit' | 'exit_code';

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

/** 工具输入使用 prepare 后的结果，即即将审批和执行的输入；调用标识用于关联后续工具事件。 */
export interface PreToolUseHookInput extends HookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

/** v1 stdout JSON 字段；未知字段忽略，已知字段类型不符按无效 JSON 处理。 */
const hookOutputSchema = z.object({
  continue: z.boolean().optional(),
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