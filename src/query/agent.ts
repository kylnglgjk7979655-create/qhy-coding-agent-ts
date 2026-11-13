import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, InvalidToolInputError, isStepCount, NoSuchToolError, ToolChoiceViolationError, ToolLoopAgent, wrapLanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ResolvedConfig } from '../services/settings/config.js';
import { AgentError, publicError } from '../utils/errors.js';
import { validatedOpenAIFetch } from '../services/api/openai-sse-fetch.js';
import type { WorkspaceFileBaselines, WorkspaceFileSnapshot } from '../tools/workspace-files.js';
import { approveToolCall } from '../tools/tool-approval.js';
import type { ApprovalControl } from '../tools/tool-approval.js';
import { MAX_TOOL_CALL_CONCURRENCY, ToolRegistry } from '../tools/tool-registry.js';
import { registerBuiltInTools } from '../tools/register-built-in-tools.js';
import { registerRemoteMCP } from '../services/mcp/remote-mcp.js';
import { DEFAULT_CONTEXT } from '../services/settings/config.js';
import { prepareConversation } from '../services/compact/context-summary.js';
import type { ToolExecutionEvent } from '../tools/tool-registry.js';
import type { BackgroundAgentTasks } from '../tools/AgentTool/background-agent-tasks.js';

export type { ApprovalControl } from '../tools/tool-approval.js';
export type { ToolApprovalRequest } from '../tools/tool-registry.js';
export type { ToolExecutionEvent } from '../tools/tool-registry.js';

export interface RunResult {
  text: string;
  responseMessages: ModelMessage[];
  /** 本轮成功使用的完整有效历史，可直接用于保存及下一轮输入。 */
  effectiveHistory: ModelMessage[];
  summaries: Array<{ text: string; coversThrough: number }>;
  steps: number;
  toolCalls: number;
  finishReason: string;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  toolSmokePassed: boolean;
}

function modelStreamError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (APICallError.isInstance(error) || ToolChoiceViolationError.isInstance(error)) return publicError(error);
  return new AgentError('PROVIDER_ERROR', '模型响应流无效，已终止当前对话轮次。');
}

export async function runAgent(
  config: ResolvedConfig,
  prompt: string,
  options: {
    smokeTool: boolean;
    history?: ModelMessage[];
    onText?: (chunk: string) => Promise<void> | void;
    onToolCallStart?: (call: { callId: string; toolName: string; input: unknown }) => Promise<void> | void;
    onStepMessages?: (content: unknown[]) => Promise<void> | void;
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
    fileBaselines?: WorkspaceFileBaselines;
    onToolCall?: (name: string) => void;
    onToolEvent?: (event: ToolExecutionEvent) => unknown;
    signal?: AbortSignal;
    approvalControl?: ApprovalControl;
    /** 摘要成功后立即持久化压缩检查点；保存失败按停止本轮处理，不报告压缩成功。 */
    onCompaction?: (checkpoint: { effectiveHistory: ModelMessage[]; summary: { text: string } }) => Promise<{ coversThrough: number } | void> | { coversThrough: number } | void;
    /** 会话原始记录路径，写入摘要续接包装供后续找回细节；子 Agent 没有会话记录时省略。 */
    transcriptPath?: string;
    summaryCoverageBase?: number;
    /** general-purpose 子 Agent 使用独立循环，但不公布 agent 工具。 */
    generalPurposeSubagent?: boolean;
    modelOverride?: string;
    backgroundTasks?: BackgroundAgentTasks;
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
  const frameworkAbort = new AbortController();
  const bashOperations = new Set<Promise<unknown>>();
  let frameworkError: AgentError | undefined;
  const deadline = new AbortController();
  const pairingAbort = new AbortController();
  let pairingError: AgentError | undefined;
  let remainingMs = config.timeoutMs;
  let deadlinePauseDepth = 0;
  let activeSince = performance.now();
  let timer = setTimeout(() => deadline.abort(), remainingMs);
  const signal = options.signal === undefined
    ? AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal])
    : AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal, options.signal]);
  let preparedHistory: ModelMessage[] = [];
  function pauseDeadline(): void {
    signal.throwIfAborted();
    deadlinePauseDepth += 1;
    if (deadlinePauseDepth > 1) return;
    clearTimeout(timer);
    remainingMs -= performance.now() - activeSince;
    if (remainingMs <= 0) {
      deadlinePauseDepth = 0;
      deadline.abort();
    }
    signal.throwIfAborted();
  }
  function resumeDeadline(): void {
    if (deadlinePauseDepth === 0) return;
    deadlinePauseDepth -= 1;
    if (deadlinePauseDepth > 0 || signal.aborted) return;
    activeSince = performance.now();
    timer = setTimeout(() => deadline.abort(), remainingMs);
  }
  const registry = new ToolRegistry({
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
    ...(options.onToolCallStart ? { beforeTool: options.onToolCallStart } : {}),
    approve: async (call) => {
      signal.throwIfAborted();
      try {
        return await approveToolCall(config, call, signal, options.approvalControl, { pause: pauseDeadline, resume: resumeDeadline }, preparedHistory);
      } catch (error) {
        if (!signal.aborted) {
          frameworkError = error instanceof AgentError ? error : new AgentError('APPROVAL_ERROR', '工具审批故障，已停止本轮。');
          frameworkAbort.abort(frameworkError);
        }
        throw error;
      }
    },
  });
  const fileBaselines = options.fileBaselines ?? new Map<string, WorkspaceFileSnapshot>();
  registerBuiltInTools(registry, {
    config,
    probe,
    allowAgent: !options.generalPurposeSubagent,
    ...(options.approvalControl === undefined ? {} : { approvalControl: options.approvalControl }),
    ...(options.backgroundTasks === undefined ? {} : { backgroundTasks: options.backgroundTasks }),
    fileWriteCallbacks: {
      ...(options.onBeforeWrite === undefined ? {} : { onBeforeWrite: options.onBeforeWrite }),
      ...(options.onCheckpointError === undefined ? {} : { onCheckpointError: options.onCheckpointError }),
    },
    fileBaselines,
    bashOperations,
  });
  let closeMCP: (() => Promise<void>) | undefined;
  try {
    closeMCP = await registerRemoteMCP(config, registry, signal);
    const model = wrapLanguageModel({
      model: provider.chat(options.modelOverride ?? config.model),
      middleware: {
        wrapStream: async ({ doStream }) => {
          signal.throwIfAborted();
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
    const instructions = [
        '你是基础 CLI Agent。请直接回答用户需求，默认使用中文。',
        '搜索文件路径时优先使用 glob，搜索文件内容时优先使用 grep；两者默认搜索整个工作区，也可限定子目录，遵循 .gitignore 并包含隐藏目录。',
        '可使用 read_file 读取文件：工作区内默认允许，工作区外需要审批；使用 write_file 完整替换或创建文件，工作区外写入默认需要审批。Read 与 Write 权限规则按请求路径和实际目标执行。',
        'write_file 和 Bash 默认需要独立审批，批准只适用于当前调用及参数；权限拒绝不会执行操作。',
        'Bash 可运行命令和项目测试，每次使用独立 shell，继承 CLI 环境并以宿主当前用户权限执行；cwd 只约束启动位置，不提供文件系统或网络隔离。',
        '工具结果中的 is_error: true 表示该调用失败；必须在答复中明确说明失败，不得声称操作成功或把失败调用的输出当成已验证结果。',
        'runtimeInfo 可获取工作区路径和本次探针。',
        '如公布了 mcp_ 前缀工具，可调用对应远程 MCP 服务；这些工具默认需要独立审批，调用可能产生远端副作用。',
        '参数已知且彼此无依赖的工具调用尽量放在同一批；需要前序调用结果的工具调用应分批。',
        ...(options.generalPurposeSubagent ? [
          '你是 general-purpose 子 Agent，负责独立完成委派的研究或多步骤修改任务。',
          '你不能再委派子 Agent。',
        ] : []),
    ].join('\n');
    const tools = registry.tools();
    let preparedResponseCount = 0;
    const summaries: RunResult['summaries'] = [];
    let summaryCoverageBase = options.summaryCoverageBase ?? 0;
    let hasSummary = summaryCoverageBase > 0;
    const agent = new ToolLoopAgent({
      model,
      instructions,
      maxOutputTokens: (config.context ?? DEFAULT_CONTEXT).answerReserveTokens,
      tools,
      // SDK 的工作池负责并发上限；registry 按声明执行独占屏障与队首调度。
      toolCallConcurrency: MAX_TOOL_CALL_CONCURRENCY,
      stopWhen: isStepCount(config.maxSteps),
      onError: ({ error }) => {
        if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) return;
        frameworkError ??= modelStreamError(error);
        frameworkAbort.abort(frameworkError);
      },
      // Avoid automatic retries hiding auth failures or extending the deadline.
      maxRetries: 0,
      prepareStep: async ({ stepNumber, messages, responseMessages }) => {
        signal.throwIfAborted();
        preparedHistory = await prepareConversation(config, instructions, messages, tools, signal, async (summary) => {
          // 优先使用持久化层按实际 transcript 计算的覆盖边界，避免依赖摘要或附件占用的消息数量。
          let saved: { coversThrough: number } | void = undefined;
          if (options.onCompaction) {
            try {
              saved = await options.onCompaction({ effectiveHistory: summary.compacted, summary: { text: summary.text } });
            } catch {
              signal.throwIfAborted();
              throw new AgentError('PROVIDER_ERROR', '压缩检查点保存失败，已停止本轮；压缩前的有效历史保持不变。');
            }
          }
          const coversThrough = saved?.coversThrough
            ?? summaryCoverageBase + summary.coveredMessages - (hasSummary ? 1 : 0);
          const entry = { text: summary.text, coversThrough };
          summaries.push(entry);
          summaryCoverageBase = coversThrough;
          hasSummary = true;
        }, options.transcriptPath);
        preparedHistory = [...preparedHistory];
        preparedResponseCount = responseMessages.length;
        signal.throwIfAborted();
        return {
          messages: preparedHistory,
          ...(options.smokeTool ? { toolChoice: stepNumber === 0
            ? { type: 'tool' as const, toolName: 'read_file' as const }
            : 'none' as const } : {}),
        };
      },
    });

    signal.throwIfAborted();
    const inputMessages: ModelMessage[] = [
      ...(options.smokeTool ? [] : options.history ?? []),
      {
        role: 'user',
        content: options.smokeTool
          ? `调用 read_file 读取 ${smokeProbePath}，然后在最终回答中逐字写出文件内容。`
          : prompt,
      },
    ];
    const result = await agent.stream({
      messages: inputMessages,
      abortSignal: signal,
      experimental_transform: () => new TransformStream({
        transform(part, controller) {
          if (part.type !== 'tool-error') {
            controller.enqueue(part);
            return;
          }
          const rejection = registry.reject(part.toolCallId, part.toolName, part.error);
          if (!rejection) {
            frameworkError ??= new AgentError('PROVIDER_ERROR', '工具执行发生不可恢复错误，已终止当前对话轮次。');
            frameworkAbort.abort(frameworkError);
            controller.error(frameworkError);
            return;
          }
          controller.enqueue({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: rejection,
          } as unknown as typeof part);
        },
      }),
      onStepFinish: async ({ toolCalls, toolResults, content }) => {
        if (signal.aborted) return;
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
        await options.onStepMessages?.(content);
      },
    });
    for await (const chunk of result.textStream) await options.onText?.(chunk);
    const [steps, responseMessages, text, finishReason, totalUsage] = await Promise.all([
      result.steps,
      result.responseMessages,
      result.text,
      result.finishReason,
      result.totalUsage,
    ]);
    signal.throwIfAborted();
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
      // 最后一次请求的历史已包含此前工具往返，只追加该请求之后的新响应。
      effectiveHistory: [...preparedHistory, ...responseMessages.slice(preparedResponseCount)],
      summaries,
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
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof AgentError ? reason : new AgentError('CANCELLED', '请求已取消。');
    }
    if (deadline.signal.aborted) {
      throw new AgentError('TIMEOUT', `请求超过 ${config.timeoutMs}ms，已终止。`);
    }
    if (pairingError) throw pairingError;
    if (frameworkError) throw frameworkError;
    throw error;
  } finally {
    clearTimeout(timer);
    await closeMCP?.();
    await Promise.allSettled(bashOperations);
    if (options.smokeTool) await unlink(join(config.workspace, smokeProbePath)).catch(() => undefined);
  }
}
