import { z } from 'zod';
import type { ResolvedConfig } from '../../services/settings/config.js';
import { runAgent } from '../../query/agent.js';
import { runExplore } from '../../query/explore.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ApprovalControl } from '../tool-approval.js';
import type { BackgroundAgentTasks } from './background-agent-tasks.js';
import type { WorkspaceFileSnapshot } from '../workspace-files.js';

export function registerAgentTool(
  registry: ToolRegistry,
  config: ResolvedConfig,
  approvalControl?: ApprovalControl,
  backgroundTasks?: BackgroundAgentTasks,
  fileWriteCallbacks: {
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
  } = {},
): void {
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
      if (type === 'general-purpose') {
        if (background === true) {
          if (!backgroundTasks) throw new ToolExecutionError('当前调用没有绑定主会话，无法启动后台子 Agent。', undefined);
          const launched = backgroundTasks.launch(execution.toolCallId, description, async (signal) => {
            const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
              smokeTool: false,
              generalPurposeSubagent: true,
              signal,
              ...(fileWriteCallbacks.onBeforeWrite === undefined ? {} : { onBeforeWrite: fileWriteCallbacks.onBeforeWrite }),
              ...(fileWriteCallbacks.onCheckpointError === undefined ? {} : { onCheckpointError: fileWriteCallbacks.onCheckpointError }),
              ...(approvalControl === undefined ? {} : { approvalControl }),
              ...(model === undefined ? {} : { modelOverride: model }),
            });
            return { report: result.text, usage: result.usage };
          });
          return {
            ...launched,
            status: 'running',
            collaborationHint: `后台任务仍在运行；避免重复启动。使用 agent(subagent_type="task-manager", description="status|wait|cancel", prompt="任务 ID") 管理任务；wait 可在 prompt 中用逗号分隔多个 ID。`,
          };
        }
        const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
          smokeTool: false,
          generalPurposeSubagent: true,
          ...(fileWriteCallbacks.onBeforeWrite === undefined ? {} : { onBeforeWrite: fileWriteCallbacks.onBeforeWrite }),
          ...(fileWriteCallbacks.onCheckpointError === undefined ? {} : { onCheckpointError: fileWriteCallbacks.onCheckpointError }),
          ...(approvalControl === undefined ? {} : { approvalControl }),
          ...(model === undefined ? {} : { modelOverride: model }),
          ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
        });
        return { report: result.text };
      }
      if (background === true) throw new ToolExecutionError('Explore 暂不支持后台模式。', undefined);
      if (type !== 'explore') throw new ToolExecutionError(`未知子智能体类型“${subagent_type}”；可用类型：general-purpose、Explore。`, undefined);
      const report = await runExplore(config, description, prompt, model, execution.abortSignal, approvalControl);
      return { report };
    },
  });
}
