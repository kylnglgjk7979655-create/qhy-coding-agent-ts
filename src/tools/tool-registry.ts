import { InvalidToolInputError, NoSuchToolError, tool } from 'ai';
import type { FlexibleSchema, ToolExecutionOptions, ToolSet } from 'ai';
import { AgentError } from '../utils/errors.js';

export interface ToolExecutionEvent {
  callId: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed' | 'rejected';
  description?: string;
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
    approve?: (call: ToolApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  }) {}

  register<Input, Output>(definition: {
    name: string;
    description: string;
    inputSchema: FlexibleSchema<Input>;
    concurrency?: 'parallel' | 'exclusive';
    prepare?: (input: Input) => Promise<{ input: Input; details?: Record<string, string> }>;
    execute: (input: Input, options: ToolExecutionOptions<unknown>) => Promise<Output> | Output;
  }): void {
    const { name, description, inputSchema, execute, prepare, concurrency = 'exclusive' } = definition;
    if (this.registered.has(name)) {
      throw new AgentError('CONFIG_ERROR', `工具名称重复注册：${name}。`);
    }
    this.registered.set(name, tool({
      description,
      inputSchema,
      execute: async (input, execution) => this.scheduler.run(concurrency, execution.abortSignal, async () => {
        const eventDetails = name === 'agent' && typeof input === 'object' && input !== null
          && 'description' in input && typeof input.description === 'string'
          ? { description: input.description }
          : {};
        execution.abortSignal?.throwIfAborted();
        let prepared;
        try {
          prepared = prepare ? await prepare(input) : { input };
        } catch {
          execution.abortSignal?.throwIfAborted();
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'rejected', errorCode: 'INVALID_TOOL_ARGUMENTS' });
          return { is_error: true as const, error: { code: 'INVALID_TOOL_ARGUMENTS' as const, message: '工具参数无效：操作目标不可用或越出工作区。' } };
        }
        execution.abortSignal?.throwIfAborted();
        await this.options.beforeTool?.({ callId: execution.toolCallId, toolName: name, input });
        execution.abortSignal?.throwIfAborted();
        if (this.options.approve && !await this.options.approve({ callId: execution.toolCallId, toolName: name, input, ...(prepared.details ? { details: prepared.details } : {}) }, execution.abortSignal)) {
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'rejected', errorCode: 'PERMISSION_DENIED' });
          return { is_error: true as const, error: { code: 'PERMISSION_DENIED' as const, message: '本次工具调用未获权限批准。' } };
        }
        execution.abortSignal?.throwIfAborted();
        this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'started' });
        try {
          const output = await execute(prepared.input, execution);
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'succeeded' });
          return { is_error: false as const, output };
        } catch (error) {
          execution.abortSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : '工具执行失败。';
          this.report({ callId: execution.toolCallId, toolName: name, ...eventDetails, status: 'failed', errorCode: 'TOOL_EXECUTION_ERROR' });
          return { is_error: true as const, error: { code: 'TOOL_EXECUTION_ERROR' as const, message },
            ...(error instanceof ToolExecutionError ? { output: error.output } : {}) };
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
