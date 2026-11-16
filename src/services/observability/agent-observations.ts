import type { LanguageModelCallEndEvent, LanguageModelCallStartEvent, ToolExecutionEndEvent, ToolExecutionStartEvent } from 'ai';
import type { ToolApprovalRequest } from '../../tools/tool-registry.js';
import { childGeneration, childScope, childSpan } from './langfuse.js';
import type { ObservationHandle, ObservationStatus, TracingScope } from './langfuse.js';

interface ToolCallIdentity {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

function toolCallOf(event: ToolExecutionStartEvent | ToolExecutionEndEvent): ToolCallIdentity {
  const call = event.toolCall as Partial<ToolCallIdentity>;
  return {
    toolCallId: typeof call.toolCallId === 'string' ? call.toolCallId : '',
    toolName: typeof call.toolName === 'string' ? call.toolName : 'unknown',
    input: call.input,
  };
}

/** 工具结果信封由 registry 统一产生；权限拒绝与执行失败在跟踪中没有虚构的成功状态。 */
function toolOutputStatus(output: unknown): ObservationStatus {
  if (typeof output !== 'object' || output === null || !('is_error' in output) || output.is_error !== true) return 'succeeded';
  const error = 'error' in output && typeof output.error === 'object' && output.error !== null
    ? output.error as { code?: unknown }
    : undefined;
  return error?.code === 'PERMISSION_DENIED' ? 'rejected' : 'failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败。';
}

/**
 * 把 AI SDK 的模型调用与工具执行事件映射为 Langfuse 观察。
 * 所有记录均为尽力而为：缺少跟踪 scope 时方法退化为空操作，绝不改变 Agent 结果。
 */
export class AgentObservations {
  private readonly generations = new Map<string, ObservationHandle>();
  private readonly tools = new Map<string, ObservationHandle>();

  constructor(
    private readonly scope: TracingScope | undefined,
    /** 独立请求（摘要、审批）使用不同的生成名称，避免与主 Agent 请求混淆。 */
    private readonly modelRequestName = 'model.request',
  ) {}

  startModelCall(event: LanguageModelCallStartEvent): void {
    const handle = childGeneration(this.scope, {
      name: this.modelRequestName,
      model: event.modelId,
      input: { instructions: event.instructions, messages: event.messages },
      metadata: { provider: event.provider, callId: event.callId },
    });
    if (handle !== undefined) this.generations.set(event.callId, handle);
  }

  endModelCall(event: LanguageModelCallEndEvent): void {
    const handle = this.generations.get(event.callId);
    if (handle === undefined) return;
    this.generations.delete(event.callId);
    const failed = event.finishReason === 'error';
    handle.end({
      output: event.content,
      status: failed ? 'failed' : 'succeeded',
      usage: {
        ...(event.usage.inputTokens === undefined ? {} : { inputTokens: event.usage.inputTokens }),
        ...(event.usage.outputTokens === undefined ? {} : { outputTokens: event.usage.outputTokens }),
        ...(event.usage.totalTokens === undefined ? {} : { totalTokens: event.usage.totalTokens }),
      },
      metadata: {
        finishReason: event.finishReason,
        responseId: event.responseId,
        responseTimeMs: event.performance.responseTimeMs,
      },
      ...(failed ? { error: { code: 'MODEL_ERROR', message: '模型调用以错误结束。' } } : {}),
    });
  }

  failModelCall(callId: string, error: unknown): void {
    const handle = this.generations.get(callId);
    if (handle === undefined) return;
    this.generations.delete(callId);
    const cancelled = error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR');
    handle.end({
      status: cancelled ? 'cancelled' : 'failed',
      ...(cancelled ? {} : { error: { code: 'MODEL_ERROR', message: errorMessage(error) } }),
    });
  }

  abortPending(): void {
    for (const handle of this.generations.values()) handle.end({ status: 'cancelled' });
    this.generations.clear();
  }

  startTool(event: ToolExecutionStartEvent): void {
    const { toolCallId, toolName, input } = toolCallOf(event);
    const handle = childSpan(this.scope, { name: `tool.${toolName}`, input, metadata: { toolCallId } });
    if (handle !== undefined) this.tools.set(toolCallId, handle);
  }

  endTool(event: ToolExecutionEndEvent): void {
    const { toolCallId, toolName } = toolCallOf(event);
    const handle = this.tools.get(toolCallId);
    if (handle === undefined) return;
    this.tools.delete(toolCallId);
    const output = event.toolOutput as { type?: unknown; output?: unknown; error?: unknown };
    const status = output.type === 'tool-result' ? toolOutputStatus(output.output) : 'failed';
    handle.end({
      output: output.type === 'tool-result' ? output.output : output.error,
      status,
      metadata: { toolCallId, toolName, toolExecutionMs: event.toolExecutionMs },
      ...(status === 'failed' ? { error: { code: 'TOOL_EXECUTION_ERROR', message: errorMessage(output.error) } } : {}),
    });
  }

  private toolObservationId(toolCallId: string): string | undefined {
    return this.tools.get(toolCallId)?.id;
  }

  /**
   * 审批观察挂在触发它的工具 span 下；模型审批的 generation 继续挂在审批 span 下。
   * 不存在跟踪时直接执行原操作。
   */
  async traceApproval(call: ToolApprovalRequest, run: (tracing: TracingScope | undefined) => Promise<boolean>): Promise<boolean> {
    const parentObservationId = this.toolObservationId(call.callId) ?? this.scope?.parentObservationId;
    const parent = this.scope === undefined
      ? undefined
      : { ...this.scope, ...(parentObservationId === undefined ? {} : { parentObservationId }) };
    const span = parent === undefined
      ? undefined
      : childSpan(parent, {
        name: `approval.${call.toolName}`,
        input: { toolName: call.toolName, input: call.input, details: call.details },
      });
    try {
      const approved = await run(childScope(parent, span));
      span?.end({ output: approved ? 'approve' : 'deny', status: approved ? 'succeeded' : 'rejected' });
      return approved;
    } catch (error) {
      span?.end({ status: 'failed', error: { code: 'APPROVAL_ERROR', message: errorMessage(error) } });
      throw error;
    }
  }

  /** 摘要 span 包住摘要模型请求，最终输出与覆盖消息数一并记录。 */
  async traceSummary<T>(
    messageCount: number,
    run: (tracing: TracingScope | undefined) => Promise<T>,
    output: (result: T) => unknown,
  ): Promise<T> {
    const span = childSpan(this.scope, { name: 'conversation.summary', metadata: { messageCount } });
    try {
      const result = await run(childScope(this.scope, span));
      span?.end({ output: output(result), status: 'succeeded' });
      return result;
    } catch (error) {
      span?.end({ status: 'failed', error: { code: 'SUMMARY_ERROR', message: errorMessage(error) } });
      throw error;
    }
  }
}