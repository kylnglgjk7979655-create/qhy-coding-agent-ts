import { z } from 'zod';
import type { ResolvedConfig } from '../../services/settings/config.js';
import { runAgent } from '../../query/agent.js';
import { runExplore } from '../../query/explore.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ApprovalControl } from '../tool-approval.js';
import type { BackgroundAgentTasks } from './background-agent-tasks.js';

export function registerAgentTool(registry: ToolRegistry, config: ResolvedConfig, approvalControl?: ApprovalControl, backgroundTasks?: BackgroundAgentTasks): void {
  registry.register({
    name: 'agent',
    concurrency: 'parallel',
    description: '委派任务给子 Agent；默认 general-purpose，可选只读 Explore。默认前台等待；background=true 仅对 general-purpose 后台启动并立即返回，避免重复任务。',
    inputSchema: z.strictObject({
      description: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
      subagent_type: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      background: z.boolean().optional(),
    }),
    execute: async ({ description, prompt, subagent_type, model, background }, execution) => {
      const type = subagent_type?.toLowerCase() ?? 'general-purpose';
      if (type === 'general-purpose') {
        if (background === true) {
          if (!backgroundTasks) throw new ToolExecutionError('当前调用没有绑定主会话，无法启动后台子 Agent。', undefined);
          const launched = backgroundTasks.launch(execution.toolCallId, async (signal) => {
            const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
              smokeTool: false,
              generalPurposeSubagent: true,
              signal,
              ...(approvalControl === undefined ? {} : { approvalControl }),
              ...(model === undefined ? {} : { modelOverride: model }),
            });
            return result.text;
          });
          return {
            ...launched,
            status: 'running',
            collaborationHint: '后台任务仍在运行；请先继续其他工作，避免重复启动相同或重叠任务。',
          };
        }
        const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
          smokeTool: false,
          generalPurposeSubagent: true,
          ...(approvalControl === undefined ? {} : { approvalControl }),
          ...(model === undefined ? {} : { modelOverride: model }),
          ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
        });
        return { report: result.text };
      }
      if (background === true) throw new ToolExecutionError('Explore 暂不支持后台模式。', undefined);
      if (type !== 'explore') throw new ToolExecutionError(`未知子智能体类型“${subagent_type}”；可用类型：general-purpose、Explore。`, undefined);
      // TODO: 将 Explore 内部只读工具纳入工具策略与审批；当前仅外层 agent 调用受策略控制。
      const report = await runExplore(config, description, prompt, model, execution.abortSignal);
      return { report };
    },
  });
}
