import { InvalidToolInputError, NoSuchToolError, asSchema, tool } from 'ai';
import type { FlexibleSchema, ToolExecutionOptions, ToolSet } from 'ai';
import { AgentError } from '../utils/errors.js';

/** 工具错误码的完整枚举；Hook 的 error_code 只允许取这些值，不接受自由字符串。 */
export const TOOL_ERROR_CODES = [
  'INVALID_TOOL_ARGUMENTS',
  'UNKNOWN_TOOL',
  'TOOL_EXECUTION_ERROR',
  'PERMISSION_DENIED',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolExecutionEvent {
  callId: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed' | 'rejected';
  description?: string;
  errorCode?: ToolErrorCode;
}

/** PreToolUse 的聚合结论；deny 已在审批前短路，因此审批请求只会携带 allow 或 ask。 */
export interface ToolPreToolUseDecision {
  /** 权限结论；省略表示 Hook 只提供改写或未给出结论。 */
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  /** 已通过工具 inputSchema 校验的改写输入；deny 时 registry 不应用。 */
  updatedInput?: unknown;
}

/** 注册时保留的校验与准备能力，供 PreToolUse 改写后重新校验并生成审批细节。 */
interface RegisteredToolDefinition {
  validateInput: (value: unknown) => Promise<boolean>;
  prepare?: (input: unknown) => Promise<{
    input: unknown;
    details?: Record<string, string>;
    cleanup?: () => Promise<void> | void;
  }>;
}

export interface ToolApprovalRequest {
  callId: string;
  toolName: string;
  input: unknown;
  details?: Record<string, string>;
  /** Hook 的 allow/ask 结论与理由；deny 不会进入审批。 */
  hookPermission?: { decision: 'allow' | 'ask'; reason?: string };
}

type ToolFailure = { is_error: true; error: { code: ToolErrorCode; message: string } };
function permissionDeniedResult(): ToolFailure {
  return { is_error: true, error: { code: 'PERMISSION_DENIED', message: '本次工具调用未获权限批准。' } };
}

/** 用注册时的 prepare 重新生成改写输入的审批细节与执行输入；失败时回退。 */
async function prepareUpdatedInput(definition: RegisteredToolDefinition, input: unknown) {
  try {
    return definition.prepare === undefined ? { input } : await definition.prepare(input);
  } catch {
    process.stderr.write('[hook] PreToolUse: updatedInput 无法准备，已回退原输入（不影响工具）。\n');
    return undefined;
  }
}

export const MAX_TOOL_CALL_CONCURRENCY = 10;

interface ScheduledCall {
  concurrency: 'parallel' | 'exclusive';
  signal?: AbortSignal;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

class ToolCallScheduler {
  private readonly queued: ScheduledCall[] = [];
  private active = 0;
  private exclusiveActive = false;

  run<T>(concurrency: 'parallel' | 'exclusive', signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const call: ScheduledCall = {
        concurrency,
        ...(signal ? { signal } : {}),
        run: operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (signal) {
        call.onAbort = () => {
          const index = this.queued.indexOf(call);
          if (index < 0) return;
          this.queued.splice(index, 1);
          reject(signal.reason ?? new Error('工具调用已取消。'));
          this.drain();
        };
        signal.addEventListener('abort', call.onAbort, { once: true });
      }
      this.queued.push(call);
      if (signal?.aborted) call.onAbort?.();
      else this.drain();
    });
  }

  private drain(): void {
    while (!this.exclusiveActive && this.queued.length > 0) {
      const call = this.queued[0]!;
      if (call.concurrency === 'exclusive' && this.active > 0) return;
      if (call.concurrency === 'parallel' && this.active >= MAX_TOOL_CALL_CONCURRENCY) return;
      this.queued.shift();
      if (call.onAbort) call.signal?.removeEventListener('abort', call.onAbort);
      this.active += 1;
      if (call.concurrency === 'exclusive') this.exclusiveActive = true;
      void Promise.resolve().then(() => {
        call.signal?.throwIfAborted();
        return call.run();
      }).then(call.resolve, call.reject).finally(() => {
        this.active -= 1;
        if (call.concurrency === 'exclusive') this.exclusiveActive = false;
        this.drain();
      });
      if (call.concurrency === 'exclusive') return;
    }
  }
}

// 操作失败仍可携带业务输出，例如命令的退出状态和已收集输出。
export class ToolExecutionError extends Error {
  constructor(message: string, readonly output: unknown) { super(message); }
}

// SDK 负责参数校验、调用 ID 与结果配对；registry 按工具声明调度执行。
export class ToolRegistry {
  private readonly registered = new Map<string, ToolSet[string]>();
  private readonly scheduler = new ToolCallScheduler();

  constructor(private readonly options: {
    onToolEvent?: (event: ToolExecutionEvent) => unknown;
    beforeTool?: (event: { callId: string; toolName: string; input: unknown }) => Promise<void> | void;
    /** 在 prepare 与 beforeTool 之后、审批之前运行；输入为 prepare 后的结果。 */
    preToolUse?: (call: {
      callId: string;
      toolName: string;
      input: unknown;
      /** 按该工具注册的 inputSchema 校验 PreToolUse 候选输入。 */
      validateInput: (value: unknown) => Promise<boolean>;
    }, signal?: AbortSignal) => Promise<ToolPreToolUseDecision | undefined>;
    /** execute 成功后运行；回调失败只写 stderr，不改变工具结果或错误码。 */
    postToolUse?: (call: {
      callId: string;
      toolName: string;
      input: unknown;
      /** 与返回给模型的工具成功信封一致。 */
      response: { is_error: false; output: unknown };
    }, signal?: AbortSignal) => Promise<void> | void;
    /** execute 抛错后运行；权限拒绝、参数错误与未知工具不触发，回调失败不改变错误码。 */
    postToolUseFailure?: (call: {
      callId: string;
      toolName: string;
      input: unknown;
      error: string;
      errorCode: ToolErrorCode;
    }, signal?: AbortSignal) => Promise<void> | void;
    approve?: (call: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  }) {}

  register<Input, Output, PreparedInput = Input>(definition: {
    name: string;
    description: string;
    inputSchema: FlexibleSchema<Input>;
    concurrency?: 'parallel' | 'exclusive';
    approvalDetails?: Record<string, string>;
    prepare?: (input: Input) => Promise<{
      input: PreparedInput;
      details?: Record<string, string>;
      /** 准备阶段占用资源时释放；审批拒绝或执行结束都会调用。 */
      cleanup?: () => Promise<void> | void;
    }>;
    execute: (input: PreparedInput, options: ToolExecutionOptions<unknown>) => Promise<Output> | Output;
  }): void {
    const { name, description, inputSchema, execute, prepare, concurrency = 'exclusive', approvalDetails } = definition;
    if (this.registered.has(name)) {
      throw new AgentError('CONFIG_ERROR', `工具名称重复注册：${name}。`);
    }
    const schema = asSchema(inputSchema);
    const validate = schema.validate;
    // 注册时保留校验与准备能力，供 PreToolUse 改写后重新校验并生成审批细节。
    const registered: RegisteredToolDefinition = {
      // 没有本地验证器时无法校验改写，保持原输入可用，不误判为非法。
      validateInput: validate === undefined
        ? async () => true
        : async (value: unknown) => {
          try { return (await validate(value)).success; } catch { return false; }
        },
      ...(prepare === undefined
        ? {}
        : { prepare: async (value: unknown) => prepare(value as Input) }),
    };
    this.registered.set(name, tool({
      description,
      inputSchema,
      execute: async (input, execution) => this.scheduler.run(concurrency, execution.abortSignal, async () => {
        const eventDetails = name === 'agent' && typeof input === 'object' && input !== null
          && 'description' in input && typeof input.description === 'string'
          ? { description: input.description }
          : {};
        execution.abortSignal?.throwIfAborted();
        let prepared: { input: PreparedInput; details?: Record<string, string>; cleanup?: () => Promise<void> | void };
        try {
          prepared = prepare ? await prepare(input) : { input: input as unknown as PreparedInput };
        } catch {
          execution.abortSignal?.throwIfAborted();
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'rejected', errorCode: 'INVALID_TOOL_ARGUMENTS' });
          return { is_error: true as const, error: { code: 'INVALID_TOOL_ARGUMENTS' as const, message: '工具参数无效：操作目标不可用或越出工作区。' } };
        }
        // 准备阶段的资源无论审批结果或执行成败都由 registry 释放；执行层内部清理可重复调用。
        try {
          execution.abortSignal?.throwIfAborted();
          await this.options.beforeTool?.({ callId: execution.toolCallId, toolName: name, input });
          execution.abortSignal?.throwIfAborted();
          const hookDecision = await this.options.preToolUse?.({
            callId: execution.toolCallId,
            toolName: name,
            input: prepared.input,
            validateInput: registered.validateInput,
          }, execution.abortSignal);
          if (hookDecision?.decision === 'deny') {
            this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'rejected', errorCode: 'PERMISSION_DENIED' });
            return permissionDeniedResult();
          }
          execution.abortSignal?.throwIfAborted();
          // 改写输入已通过 inputSchema 校验；重新 prepare 得到审批细节与执行输入。
          // 准备失败说明改写目标当前不可用，回退原输入继续正常审批。
          let approvalInput: unknown = input;
          if (hookDecision?.updatedInput !== undefined) {
            const replacement = await prepareUpdatedInput(registered, hookDecision.updatedInput);
            if (replacement !== undefined) {
              try { await prepared.cleanup?.(); } catch { /* 旧准备资源回收失败不影响改写。 */ }
              prepared = replacement as typeof prepared;
              approvalInput = hookDecision.updatedInput;
            }
          }
          execution.abortSignal?.throwIfAborted();
          const details = { ...approvalDetails, ...prepared.details };
          const hookPermission = hookDecision?.decision === undefined
            ? undefined
            : {
              decision: hookDecision.decision,
              ...(hookDecision.reason === undefined ? {} : { reason: hookDecision.reason }),
            };
          if (this.options.approve && !await this.options.approve({
            callId: execution.toolCallId,
            toolName: name,
            input: approvalInput,
            ...(Object.keys(details).length > 0 ? { details } : {}),
            ...(hookPermission === undefined ? {} : { hookPermission }),
          }, execution.abortSignal)) {
            this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'rejected', errorCode: 'PERMISSION_DENIED' });
            return permissionDeniedResult();
          }
          execution.abortSignal?.throwIfAborted();
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'started' });
          try {
            const output = await execute(prepared.input, execution);
            const response = { is_error: false as const, output };
            this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'succeeded' });
            // 反馈只作为后续模型请求的附加上下文；Hook 故障不能改变已成功的结果。
            try {
              await this.options.postToolUse?.({
                callId: execution.toolCallId,
                toolName: name,
                input: prepared.input,
                response,
              }, execution.abortSignal);
            } catch {
              if (!execution.abortSignal?.aborted) {
                process.stderr.write('[hook] PostToolUse: 执行失败（已忽略，不影响工具）\n');
              }
            }
            return response;
          } catch (error) {
            execution.abortSignal?.throwIfAborted();
            const message = error instanceof Error ? error.message : '工具执行失败。';
            // execute 抛错是 v1 唯一会触发 PostToolUseFailure 的路径；错误码来自固定枚举。
            const errorCode = 'TOOL_EXECUTION_ERROR' as const;
            this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'failed', errorCode });
            try {
              await this.options.postToolUseFailure?.({
                callId: execution.toolCallId,
                toolName: name,
                input: prepared.input,
                error: message,
                errorCode,
              }, execution.abortSignal);
            } catch {
              if (!execution.abortSignal?.aborted) {
                process.stderr.write('[hook] PostToolUseFailure: 执行失败（已忽略，不影响工具）\n');
              }
            }
            return { is_error: true as const, error: { code: errorCode, message },
              ...(error instanceof ToolExecutionError ? { output: error.output } : {}) };
          }
        } finally {
          try {
            await prepared.cleanup?.();
          } catch {
            // 清理失败不影响工具结果，也不能掩盖执行阶段的错误。
          }
        }
      }),
    }));
  }

  tools(): ToolSet {
    return Object.fromEntries(this.registered);
  }

  reject(callId: string, toolName: string, error: unknown): ToolFailure | undefined {
    const errorText = typeof error === 'string' ? error : '';
    const invalidInput = InvalidToolInputError.isInstance(error) || errorText.startsWith('AI_InvalidToolInputError:');
    const unknownTool = NoSuchToolError.isInstance(error) || errorText.startsWith('AI_NoSuchToolError:');
    if (!invalidInput && !unknownTool) return undefined;
    const code = unknownTool ? 'UNKNOWN_TOOL' : 'INVALID_TOOL_ARGUMENTS';
    this.report({ callId, toolName, status: 'rejected', errorCode: code });
    return { is_error: true, error: {
      code,
      message: invalidInput
        ? '工具参数无效，请根据工具参数定义修正后重试。'
        : `不存在名为 ${toolName} 的工具。`,
    } };
  }

  private report(event: ToolExecutionEvent): void {
    try {
      const notification = this.options.onToolEvent?.(event);
      if (typeof notification === 'object' && notification !== null && 'then' in notification && typeof notification.then === 'function') {
        void Promise.resolve(notification).catch(() => {
          process.stderr.write('执行事件通知失败。\n');
        });
      }
    } catch {
      // 事件通知只用于观察，不改变工具结果。
      process.stderr.write('执行事件通知失败。\n');
    }
  }
}
