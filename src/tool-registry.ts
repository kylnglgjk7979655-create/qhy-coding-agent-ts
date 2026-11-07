import { InvalidToolInputError, NoSuchToolError, tool } from 'ai';
import type { FlexibleSchema, ToolExecutionOptions, ToolSet } from 'ai';
import { AgentError } from './errors.js';

export interface ToolExecutionEvent {
  callId: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed' | 'rejected';
  errorCode?: 'INVALID_TOOL_ARGUMENTS' | 'UNKNOWN_TOOL' | 'TOOL_EXECUTION_ERROR' | 'PERMISSION_DENIED';
}

export interface ToolApprovalRequest {
  callId: string;
  toolName: string;
  input: unknown;
  details?: Record<string, string>;
}

type ToolErrorCode = NonNullable<ToolExecutionEvent['errorCode']>;
type ToolFailure = { is_error: true; error: { code: ToolErrorCode; message: string } };

// 操作失败仍可携带业务输出，例如命令的退出状态和已收集输出。
export class ToolExecutionError extends Error {
  constructor(message: string, readonly output: unknown) { super(message); }
}

// SDK 负责参数校验、串行调度和调用 ID；registry 统一适配操作与结果。
export class ToolRegistry {
  private readonly registered = new Map<string, ToolSet[string]>();

  constructor(private readonly options: {
    onToolEvent?: (event: ToolExecutionEvent) => unknown;
    beforeTool?: (event: { callId: string; toolName: string; input: unknown }) => Promise<void> | void;
    approve?: (call: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  }) {}

  register<Input, Output>(definition: {
    name: string;
    description: string;
    inputSchema: FlexibleSchema<Input>;
    prepare?: (input: Input) => Promise<{ input: Input; details?: Record<string, string> }>;
    execute: (input: Input, options: ToolExecutionOptions<unknown>) => Promise<Output> | Output;
  }): void {
    const { name, description, inputSchema, execute, prepare } = definition;
    if (this.registered.has(name)) {
      throw new AgentError('CONFIG_ERROR', `工具名称重复注册：${name}。`);
    }
    this.registered.set(name, tool({
      description,
      inputSchema,
      execute: async (input, execution) => {
        execution.abortSignal?.throwIfAborted();
        let prepared;
        try {
          prepared = prepare ? await prepare(input) : { input };
        } catch {
          execution.abortSignal?.throwIfAborted();
          this.report({ callId: execution.toolCallId, toolName: name, status: 'rejected', errorCode: 'INVALID_TOOL_ARGUMENTS' });
          return { is_error: true as const, error: { code: 'INVALID_TOOL_ARGUMENTS' as const, message: '工具参数无效：操作目标不可用或越出工作区。' } };
        }
        execution.abortSignal?.throwIfAborted();
        await this.options.beforeTool?.({ callId: execution.toolCallId, toolName: name, input });
        execution.abortSignal?.throwIfAborted();
        if (this.options.approve && !await this.options.approve({ callId: execution.toolCallId, toolName: name, input, ...(prepared.details ? { details: prepared.details } : {}) }, execution.abortSignal)) {
          this.report({ callId: execution.toolCallId, toolName: name, status: 'rejected', errorCode: 'PERMISSION_DENIED' });
          return { is_error: true as const, error: { code: 'PERMISSION_DENIED' as const, message: '本次工具调用未获权限批准。' } };
        }
        execution.abortSignal?.throwIfAborted();
        this.report({ callId: execution.toolCallId, toolName: name, status: 'started' });
        try {
          const output = await execute(prepared.input, execution);
          this.report({ callId: execution.toolCallId, toolName: name, status: 'succeeded' });
          return { is_error: false as const, output };
        } catch (error) {
          execution.abortSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : '工具执行失败。';
          this.report({ callId: execution.toolCallId, toolName: name, status: 'failed', errorCode: 'TOOL_EXECUTION_ERROR' });
          return { is_error: true as const, error: { code: 'TOOL_EXECUTION_ERROR' as const, message },
            ...(error instanceof ToolExecutionError ? { output: error.output } : {}) };
        }
      },
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
