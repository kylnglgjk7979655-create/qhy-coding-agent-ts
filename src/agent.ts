import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { isStepCount, ToolLoopAgent, tool } from 'ai';
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

export async function runAgent(
  config: ResolvedConfig,
  prompt: string,
  options: {
    smokeTool: boolean;
    history?: ModelMessage[];
    onText?: (chunk: string) => void;
    onToolCall?: (name: string) => void;
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
  const agent = new ToolLoopAgent({
    model: provider.chat(config.model),
    instructions: [
      '你是基础 CLI Agent。请直接回答用户需求，默认使用中文。',
      '可使用 read_file 读取工作区文件，使用 write_file 完整替换或创建工作区文件；文件访问仅限配置的工作区。',
      'runtimeInfo 可获取工作区路径和本次探针。没有执行命令的能力。',
    ].join('\n'),
    tools: {
      runtimeInfo: tool({
        description: '返回已配置的工作区绝对路径和本次运行探针。',
        inputSchema: z.object({}),
        execute: async () => ({ workspace: config.workspace, probe }),
      }),
      read_file: tool({
        description: '读取工作区内的文本文件。',
        inputSchema: z.object({ path: z.string().min(1) }),
        execute: async ({ path }) => {
          try {
            return { content: await readWorkspaceFile(config.workspace, path) };
          } catch (error) {
            return { error: error instanceof Error ? error.message : '无法读取工作区文件。' };
          }
        },
      }),
      write_file: tool({
        description: '将工作区内文件完整替换为指定内容；目标不存在时创建文件，不会创建父目录。',
        inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
        execute: async ({ path, content }) => {
          try {
            await writeWorkspaceFile(config.workspace, path, content);
            return { success: true };
          } catch (error) {
            return { error: error instanceof Error ? error.message : '无法写入工作区文件。' };
          }
        },
      }),
    },
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
