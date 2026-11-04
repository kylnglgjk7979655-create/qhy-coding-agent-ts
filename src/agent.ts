import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { InvalidToolInputError, isStepCount, NoSuchToolError, ToolLoopAgent, tool } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ResolvedConfig } from './config.js';
import { AgentError } from './errors.js';
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

function reportToolEvent(options: { onToolEvent?: (event: ToolExecutionEvent) => void }, event: ToolExecutionEvent): void {
  try {
    options.onToolEvent?.(event);
  } catch {
    // 事件通知只用于观察，不改变工具结果。
    process.stderr.write('执行事件通知失败。\n');
  }
}

async function executeTool<T>(
  options: { onToolEvent?: (event: ToolExecutionEvent) => void },
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
    onToolEvent?: (event: ToolExecutionEvent) => void;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  if (options.smokeTool && config.maxSteps < 2) {
    throw new AgentError('CONFIG_ERROR', '工具冒烟需要 maxSteps >= 2，以完成工具调用及后续回答。');
  }

  const provider = createOpenAI({
    apiKey: config.apiKey,
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
  const agent = new ToolLoopAgent({
    model: provider.chat(config.model),
    instructions: [
      '你是基础 CLI Agent。请直接回答用户需求，默认使用中文。',
      '可使用 read_file 读取工作区文件，使用 write_file 完整替换或创建工作区文件；文件访问仅限配置的工作区。',
      'runtimeInfo 可获取工作区路径和本次探针。没有执行命令的能力。',
    ].join('\n'),
    tools: agentTools,
    stopWhen: isStepCount(config.maxSteps),
    onError: () => undefined,
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
  const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  const signal = options.signal === undefined
    ? deadline.signal
    : AbortSignal.any([deadline.signal, options.signal]);
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
            controller.enqueue(part);
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
      onStepFinish: ({ toolCalls }) => {
        for (const call of toolCalls) options.onToolCall?.(call.toolName);
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
    const toolSmokePassed = toolResults.some((item) =>
      item.toolName === 'read_file' && z.object({ content: z.literal(probe) }).safeParse(item.output).success,
    ) && text.includes(probe);

    if (options.smokeTool && !toolSmokePassed) {
      throw new AgentError('TOOL_COMPATIBILITY_ERROR', '工具冒烟失败：没有完成工具执行与结果回传，请检查模型和 provider 兼容性。');
    }
    if (finishReason === 'tool-calls' && steps.length >= config.maxSteps) {
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
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.smokeTool) await unlink(join(config.workspace, smokeProbePath)).catch(() => undefined);
  }
}
