import { z } from 'zod';
import type { ApprovalMode, ResolvedConfig } from '../../services/settings/config.js';
import { runAgent } from '../../query/agent.js';
import { runExplore } from '../../query/explore.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ApprovalControl } from '../tool-approval.js';
import type { BackgroundAgentTasks } from './background-agent-tasks.js';
import type { WorkspaceFileSnapshot } from '../workspace-files.js';
import type { SkillCatalogue } from '../../services/skills/skill-registry.js';
import { isCancellationError } from '../../utils/errors.js';
import { childScope, childSpan } from '../../services/observability/langfuse.js';
import type { ObservationHandle, ObservationStatus, TracingScope } from '../../services/observability/langfuse.js';

function failureStatus(error: unknown): ObservationStatus {
  return isCancellationError(error) ? 'cancelled' : 'failed';
}

function subagentTracing(
  tracing: TracingScope | undefined,
  type: string,
  details: { description: string; prompt: string; model: string; toolCallId: string; background: boolean },
): { span: ObservationHandle | undefined; scope: TracingScope | undefined } {
  const span = childSpan(tracing, {
    name: `subagent.${type}`,
    input: { description: details.description, prompt: details.prompt },
    metadata: {
      subagentType: type,
      model: details.model,
      toolCallId: details.toolCallId,
      background: details.background,
    },
  });
  return { span, scope: childScope(tracing, span) };
}

export interface AgentToolContext {
  config: ResolvedConfig;
  approvalControl?: ApprovalControl;
  /** CLI 人工审批控制；子 Agent 仅在当前模式为 default 时使用。 */
  humanApprovalControl?: ApprovalControl;
  approvalMode?: () => ApprovalMode;
  backgroundTasks?: BackgroundAgentTasks;
  fileWriteCallbacks: {
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
  };
  skills?: SkillCatalogue;
  /** 当前运行的跟踪 scope；子 Agent 工具据此创建独立 span。 */
  tracing?: TracingScope;
}

export function registerAgentTool(registry: ToolRegistry, context: AgentToolContext): void {
  const { config, approvalControl, humanApprovalControl, approvalMode, backgroundTasks, fileWriteCallbacks, skills, tracing } = context;
  registry.register({
    name: 'agent',
    concurrency: 'parallel',
    description: '委派子 Agent；默认 general-purpose，可选只读 Explore；background=true 后台启动。',
    inputSchema: z.strictObject({
      description: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
      subagent_type: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      background: z.boolean().optional(),
    }),
    execute: async ({ description, prompt, subagent_type, model, background }, execution) => {
      const type = subagent_type?.toLowerCase() ?? 'general-purpose';
      if (type === 'task-manager') {
        if (!backgroundTasks) throw new ToolExecutionError('当前调用没有绑定主会话，无法管理后台任务。', undefined);
        const taskIds = prompt.split(',').map((taskId) => taskId.trim()).filter(Boolean);
        if (description.toLowerCase() === 'status' && taskIds.length === 1) {
          return backgroundTasks.get(taskIds[0]!) ?? { taskId: taskIds[0], status: 'not_found', message: '未找到该后台任务。' };
        }
        if (description.toLowerCase() === 'wait' && taskIds.length > 0 && taskIds.length <= 10) {
          return backgroundTasks.wait(taskIds);
        }
        if (description.toLowerCase() === 'cancel' && taskIds.length === 1) return backgroundTasks.cancel(taskIds[0]!);
        throw new ToolExecutionError('task-manager 的 description 使用 status、wait 或 cancel；prompt 填一个任务 ID，wait 可用逗号分隔多个 ID。', undefined);
      }
      const childTrace = subagentTracing(tracing, type, {
        description, prompt, model: model ?? config.model, toolCallId: execution.toolCallId, background: background === true,
      });
      const { span, scope } = childTrace;
      if (type === 'general-purpose') {
        const run = async (signal?: AbortSignal) => {
          const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
            smokeTool: false,
            generalPurposeSubagent: true,
            ...(signal === undefined ? {} : { signal }),
            ...(fileWriteCallbacks.onBeforeWrite === undefined ? {} : { onBeforeWrite: fileWriteCallbacks.onBeforeWrite }),
            ...(fileWriteCallbacks.onCheckpointError === undefined ? {} : { onCheckpointError: fileWriteCallbacks.onCheckpointError }),
            ...(approvalControl === undefined ? {} : { approvalControl }),
            ...(humanApprovalControl === undefined ? {} : { humanApprovalControl }),
            ...(approvalMode === undefined ? {} : { approvalMode }),
            ...(model === undefined ? {} : { modelOverride: model }),
            ...(skills === undefined ? {} : { skills }),
            ...(scope === undefined ? {} : { tracing: scope }),
          });
          return { report: result.text, usage: result.usage };
        };
        if (background === true) {
          if (!backgroundTasks) {
            span?.end({ status: 'failed', error: { code: 'TOOL_EXECUTION_ERROR', message: '当前调用没有绑定主会话，无法启动后台子 Agent。' } });
            throw new ToolExecutionError('当前调用没有绑定主会话，无法启动后台子 Agent。', undefined);
          }
          let launched: { taskId: string; launchCallId: string };
          try {
            launched = backgroundTasks.launch(execution.toolCallId, description, async (signal) => {
              try {
                const result = await run(signal);
                span?.end({ output: result.report, status: 'succeeded' });
                // 后台任务可能晚于主轮次结束；在任务收尾时独立刷新，避免事件滞留内存。
                void tracing?.tracer.flush();
                return result;
              } catch (error) {
                span?.end({ status: failureStatus(error), error: { code: 'SUBAGENT_ERROR', message: error instanceof Error ? error.message : '后台子 Agent 执行失败。' } });
                void tracing?.tracer.flush();
                throw error;
              }
            });
          } catch (error) {
            span?.end({ status: 'failed', error: { code: 'TOOL_EXECUTION_ERROR', message: error instanceof Error ? error.message : '无法启动后台子 Agent。' } });
            throw error;
          }
          return {
            ...launched,
            status: 'running',
            collaborationHint: `后台任务仍在运行；避免重复启动。使用 agent(subagent_type="task-manager", description="status|wait|cancel", prompt="任务 ID") 管理任务；wait 可在 prompt 中用逗号分隔多个 ID。`,
          };
        }
        try {
          const result = await run(execution.abortSignal);
          span?.end({ output: result.report, status: 'succeeded' });
          return { report: result.report };
        } catch (error) {
          span?.end({ status: failureStatus(error), error: { code: 'SUBAGENT_ERROR', message: error instanceof Error ? error.message : '子 Agent 执行失败。' } });
          throw error;
        }
      }
      if (background === true) {
        span?.end({ status: 'rejected', error: { code: 'TOOL_EXECUTION_ERROR', message: 'Explore 暂不支持后台模式。' } });
        throw new ToolExecutionError('Explore 暂不支持后台模式。', undefined);
      }
      if (type !== 'explore') {
        span?.end({ status: 'rejected', error: { code: 'TOOL_EXECUTION_ERROR', message: `未知子智能体类型“${subagent_type}”。` } });
        throw new ToolExecutionError(`未知子智能体类型“${subagent_type}”；可用类型：general-purpose、Explore。`, undefined);
      }
      try {
        const report = await runExplore(config, description, prompt, {
          ...(model === undefined ? {} : { modelOverride: model }),
          ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
          ...(approvalControl === undefined ? {} : { approvalControl }),
          ...(humanApprovalControl === undefined ? {} : { humanApprovalControl }),
          ...(approvalMode === undefined ? {} : { approvalMode }),
          ...(skills === undefined ? {} : { skills }),
          ...(scope === undefined ? {} : { tracing: scope }),
        });
        span?.end({ output: report, status: 'succeeded' });
        return { report };
      } catch (error) {
        span?.end({ status: failureStatus(error), error: { code: 'SUBAGENT_ERROR', message: error instanceof Error ? error.message : 'Explore 执行失败。' } });
        throw error;
      }
    },
  });
}