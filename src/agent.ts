import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, InvalidToolInputError, isStepCount, NoSuchToolError, ToolChoiceViolationError, ToolLoopAgent, tool, wrapLanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ResolvedConfig } from './config.js';
import { AgentError, publicError } from './errors.js';
import { readWorkspaceFile, writeWorkspaceFile } from './workspace-files.js';

export interface RunResult {
  text: string;
  responseMessages: ModelMessage[];
  steps: number;
  toolCalls: number;
  finishReason: string;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  toolSmokePassed: boolean;
}

export interface ToolExecutionEvent {
  callId: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed' | 'rejected';
  errorCode?: 'INVALID_TOOL_ARGUMENTS' | 'UNKNOWN_TOOL' | 'TOOL_EXECUTION_ERROR';
}

type ToolErrorCode = NonNullable<ToolExecutionEvent['errorCode']>;
type ToolFailure = { is_error: true; error: { code: ToolErrorCode; message: string } };

function modelStreamError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (APICallError.isInstance(error) || ToolChoiceViolationError.isInstance(error)) return publicError(error);
  return new AgentError('PROVIDER_ERROR', '模型响应流无效，已终止当前对话轮次。');
}

function reportToolEvent(options: { onToolEvent?: (event: ToolExecutionEvent) => unknown }, event: ToolExecutionEvent): void {
  try {
    const notification = options.onToolEvent?.(event);
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

async function validatedOpenAIFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const held: string[] = [];
    let pending = '';
    let collecting = false;
    let emittedThisPull = 0;
    const batch = new Map<number, { id: string; argumentsText: string; argumentsComplete: boolean }>();
    const batchIds = new Set<string>();
    function consumePendingEvents(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
      let boundary: number;
      while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)![0];
        processEvent(pending.slice(0, boundary + separator.length), controller);
        pending = pending.slice(boundary + separator.length);
      }
      return emittedThisPull > 0;
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          emittedThisPull = 0;
          if (consumePendingEvents(controller)) return;
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              pending += decoder.decode();
              consumePendingEvents(controller);
              if (pending) processEvent(pending, controller);
              controller.close();
              return;
            }
            pending += decoder.decode(value, { stream: true });
            if (consumePendingEvents(controller)) return;
          }
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
    function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: string): void {
      controller.enqueue(encoder.encode(event));
      emittedThisPull += 1;
    }
    function processEvent(event: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
      const data = event.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (!data || data === '[DONE]') {
        if (collecting) held.push(event);
        else enqueue(controller, event);
        return;
      }
      let payload: unknown;
      try { payload = JSON.parse(data); } catch {
        if (collecting) held.push(event); else enqueue(controller, event);
        return;
      }
      const choices = payload && typeof payload === 'object' && 'choices' in payload && Array.isArray(payload.choices) ? payload.choices : [];
      let hasToolDelta = false;
      let completedTools = false;
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object') continue;
        if ('delta' in choice && choice.delta && typeof choice.delta === 'object' && 'tool_calls' in choice.delta && Array.isArray(choice.delta.tool_calls)) {
          hasToolDelta = true;
          for (const item of choice.delta.tool_calls) {
            if (!item || typeof item !== 'object' || typeof item.index !== 'number') {
              throw new AgentError('PROVIDER_ERROR', '工具批次包含无法识别的调用项，已在执行前终止。');
            }
            const existing = batch.get(item.index);
            const functionDelta = 'function' in item && item.function && typeof item.function === 'object'
              ? item.function as Record<string, unknown>
              : undefined;
            const argumentFragment = typeof functionDelta?.arguments === 'string' ? functionDelta.arguments : '';
            if (existing) {
              if ('id' in item && item.id !== existing.id) {
                throw new AgentError('PROVIDER_ERROR', '同一调用索引出现不同原始 ID，已在执行前终止。');
              }
              const isStructuredRestart = argumentFragment.trimStart().startsWith('{') || argumentFragment.trimStart().startsWith('[');
              if (existing.argumentsComplete && typeof functionDelta?.name === 'string' && isStructuredRestart) {
                throw new AgentError('PROVIDER_ERROR', '完整工具参数后出现重复的调用起始帧，已在执行前终止。');
              }
              if (argumentFragment) {
                existing.argumentsText += argumentFragment;
                try { JSON.parse(existing.argumentsText); existing.argumentsComplete = true; } catch { existing.argumentsComplete = false; }
              }
              continue;
            }
            const id = typeof item.id === 'string' ? item.id : undefined;
            if (!id?.trim()) {
              throw new AgentError('PROVIDER_ERROR', '工具调用首次出现时缺少原始调用 ID，已在执行前终止。');
            }
            if (batchIds.has(id)) {
              throw new AgentError('PROVIDER_ERROR', '工具批次包含重复调用 ID，已在执行前终止。');
            }
            const argumentsText = argumentFragment;
            let argumentsComplete = false;
            if (argumentsText) {
              try { JSON.parse(argumentsText); argumentsComplete = true; } catch { /* 仍在接收参数分片。 */ }
            }
            batch.set(item.index, { id, argumentsText, argumentsComplete });
            batchIds.add(id);
          }
        }
        if ('finish_reason' in choice && (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop')) completedTools = true;
      }
      if (hasToolDelta) collecting = true;
      if (collecting) held.push(event); else enqueue(controller, event);
      if (completedTools) {
        const ids = [...batch.values()].map((item) => item.id);
        if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
          throw new AgentError('PROVIDER_ERROR', '工具批次包含缺失、空或重复的调用 ID，已在执行前终止。');
        }
        for (const item of held) enqueue(controller, item);
        held.length = 0;
        collecting = false;
        batch.clear();
        batchIds.clear();
      }
    }
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
}

async function executeTool<T>(
  options: { onToolEvent?: (event: ToolExecutionEvent) => unknown },
  callId: string,
  toolName: string,
  operation: () => Promise<T> | T,
): Promise<{ is_error: false; output: T } | ToolFailure> {
  reportToolEvent(options, { callId, toolName, status: 'started' });
  try {
    const output = await operation();
    reportToolEvent(options, { callId, toolName, status: 'succeeded' });
    return { is_error: false, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : '工具执行失败。';
    reportToolEvent(options, { callId, toolName, status: 'failed', errorCode: 'TOOL_EXECUTION_ERROR' });
    return { is_error: true, error: { code: 'TOOL_EXECUTION_ERROR', message } };
  }
}

export async function runAgent(
  config: ResolvedConfig,
  prompt: string,
  options: {
    smokeTool: boolean;
    history?: ModelMessage[];
    onText?: (chunk: string) => void;
    onToolCall?: (name: string) => void;
    onToolEvent?: (event: ToolExecutionEvent) => unknown;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  if (options.smokeTool && config.maxSteps < 2) {
    throw new AgentError('CONFIG_ERROR', '工具冒烟需要 maxSteps >= 2，以完成工具调用及后续回答。');
  }

  const provider = createOpenAI({
    apiKey: config.apiKey,
    fetch: validatedOpenAIFetch,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
  });
  const probe = randomUUID();
  const smokeProbePath = `.agent-smoke-${probe}.txt`;
  if (options.smokeTool) await writeFile(join(config.workspace, smokeProbePath), probe, { encoding: 'utf8', flag: 'wx' });
  const agentTools = {
    runtimeInfo: tool({
      description: '返回已配置的工作区绝对路径和本次运行探针。',
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => executeTool(options, toolCallId, 'runtimeInfo', () => ({ workspace: config.workspace, probe })),
    }),
    read_file: tool({
      description: '读取工作区内的文本文件。',
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      execute: async ({ path }, { toolCallId }) => executeTool(options, toolCallId, 'read_file', async () => ({ content: await readWorkspaceFile(config.workspace, path) })),
    }),
    write_file: tool({
      description: '将工作区内文件完整替换为指定内容；目标不存在时创建文件，不会创建父目录。',
      inputSchema: z.strictObject({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path, content }, { toolCallId }) => executeTool(options, toolCallId, 'write_file', async () => {
        await writeWorkspaceFile(config.workspace, path, content);
        return { success: true as const };
      }),
    }),
  };
  const frameworkAbort = new AbortController();
  let frameworkError: AgentError | undefined;
  const model = wrapLanguageModel({
    model: provider.chat(config.model),
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === 'error') {
                frameworkError = modelStreamError(part.error);
                frameworkAbort.abort(frameworkError);
                controller.error(frameworkError);
                return;
              }
              controller.enqueue(part);
            },
          })),
        };
      },
    },
  });
  const agent = new ToolLoopAgent({
    model,
    instructions: [
      '你是基础 CLI Agent。请直接回答用户需求，默认使用中文。',
      '可使用 read_file 读取工作区文件，使用 write_file 完整替换或创建工作区文件；文件访问仅限配置的工作区。',
      'runtimeInfo 可获取工作区路径和本次探针。没有执行命令的能力。',
    ].join('\n'),
    tools: agentTools,
    toolCallConcurrency: 1,
    stopWhen: isStepCount(config.maxSteps),
    onError: ({ error }) => {
      if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) return;
      frameworkError = modelStreamError(error);
      frameworkAbort.abort(frameworkError);
    },
    // Avoid automatic retries hiding auth failures or extending the deadline.
    maxRetries: 0,
    ...(options.smokeTool ? {
      prepareStep: ({ stepNumber }: { stepNumber: number }) => ({
        toolChoice: stepNumber === 0
          ? { type: 'tool' as const, toolName: 'read_file' as const }
          : 'none' as const,
      }),
    } : {}),
  });

  const deadline = new AbortController();
  const pairingAbort = new AbortController();
  let pairingError: AgentError | undefined;
  const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  const signal = options.signal === undefined
    ? AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal])
    : AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal, options.signal]);
  try {
    const result = await agent.stream({
      messages: [
        ...(options.smokeTool ? [] : options.history ?? []),
        {
          role: 'user',
          content: options.smokeTool
            ? `调用 read_file 读取 ${smokeProbePath}，然后在最终回答中逐字写出文件内容。`
            : prompt,
        },
      ],
      abortSignal: signal,
      experimental_transform: () => new TransformStream({
        transform(part, controller) {
          if (part.type !== 'tool-error') {
            controller.enqueue(part);
            return;
          }
          const errorText = typeof part.error === 'string' ? part.error : '';
          const invalidInput = InvalidToolInputError.isInstance(part.error)
            || errorText.startsWith('AI_InvalidToolInputError:');
          const unknownTool = NoSuchToolError.isInstance(part.error)
            || errorText.startsWith('AI_NoSuchToolError:');
          if (!invalidInput && !unknownTool) {
            frameworkError = new AgentError('PROVIDER_ERROR', '工具执行发生不可恢复错误，已终止当前对话轮次。');
            frameworkAbort.abort(frameworkError);
            controller.error(frameworkError);
            return;
          }
          const code = unknownTool ? 'UNKNOWN_TOOL' : 'INVALID_TOOL_ARGUMENTS';
          reportToolEvent(options, {
            callId: part.toolCallId,
            toolName: part.toolName,
            status: 'rejected',
            errorCode: code,
          });
          const message = invalidInput
            ? '工具参数无效，请根据工具参数定义修正后重试。'
            : `不存在名为 ${part.toolName} 的工具。`;
          controller.enqueue({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: { is_error: true, error: { code, message } },
          } as unknown as typeof part);
        },
      }),
      onStepFinish: ({ toolCalls, toolResults }) => {
        for (const call of toolCalls) options.onToolCall?.(call.toolName);
        // This callback is awaited by the SDK before it starts the next model request.
        const callIds = toolCalls.map(({ toolCallId }) => toolCallId);
        const resultIds = toolResults.map(({ toolCallId }) => toolCallId);
        if (new Set(callIds).size !== callIds.length || callIds.some((id) => !id.trim())
          || resultIds.length !== callIds.length || new Set(resultIds).size !== resultIds.length
          || callIds.some((id) => !resultIds.includes(id))) {
          pairingError = new AgentError('PROVIDER_ERROR', '工具调用与结果无法一一配对，已终止当前对话轮次。');
          pairingAbort.abort(pairingError);
        }
      },
    });
    for await (const chunk of result.textStream) options.onText?.(chunk);
    const [steps, responseMessages, text, finishReason, totalUsage] = await Promise.all([
      result.steps,
      result.responseMessages,
      result.text,
      result.finishReason,
      result.totalUsage,
    ]);
    const toolResults = steps.flatMap((step) => step.toolResults);
    const toolSmokePassed = toolResults.some((item) => {
      if (item.toolName !== 'read_file') return false;
      const envelope = z.object({
        is_error: z.literal(false),
        output: z.object({ content: z.literal(probe) }),
      }).safeParse(item.output);
      return envelope.success;
    }) && text.includes(probe);

    if (options.smokeTool && !toolSmokePassed) {
      throw new AgentError('TOOL_COMPATIBILITY_ERROR', '工具冒烟失败：没有完成工具执行与结果回传，请检查模型和 provider 兼容性。');
    }
    if (steps.length >= config.maxSteps && steps.at(-1)?.toolCalls.length) {
      throw new AgentError('STEP_LIMIT', `已达到 ${config.maxSteps} 步上限，任务尚未生成最终回答。`);
    }
    if (finishReason !== 'stop' || !text.trim()) {
      throw new AgentError('PROVIDER_ERROR', '模型没有返回完整回答，请检查输出限制、服务策略或模型兼容性。');
    }
    return {
      text,
      responseMessages,
      steps: steps.length,
      toolCalls: steps.reduce((count, step) => count + step.toolCalls.length, 0),
      finishReason,
      usage: {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
      },
      toolSmokePassed: options.smokeTool && toolSmokePassed,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new AgentError('CANCELLED', '请求已取消。');
    if (deadline.signal.aborted) {
      throw new AgentError('TIMEOUT', `请求超过 ${config.timeoutMs}ms，已终止。`);
    }
    if (pairingError) throw pairingError;
    if (frameworkError) throw frameworkError;
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.smokeTool) await unlink(join(config.workspace, smokeProbePath)).catch(() => undefined);
  }
}
