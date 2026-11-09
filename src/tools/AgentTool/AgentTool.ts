import { z } from 'zod';
import type { ResolvedConfig } from '../../services/settings/config.js';
import { runAgent } from '../../query/agent.js';
import { runExplore } from '../../query/explore.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ApprovalControl } from '../tool-approval.js';

export function registerAgentTool(registry: ToolRegistry, config: ResolvedConfig, approvalControl?: ApprovalControl): void {
  registry.register({
    name: 'agent',
    concurrency: 'parallel',
    description: '将研究或多步骤任务委派给独立子 Agent。默认 general-purpose；可指定 Explore 执行只读调查。提供简短任务说明和具体 prompt；model 可指定本次调用的模型。',
    inputSchema: z.strictObject({
      description: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
      subagent_type: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
    }),
    execute: async ({ description, prompt, subagent_type, model }, execution) => {
      const type = subagent_type?.toLowerCase() ?? 'general-purpose';
      if (type === 'general-purpose') {
        const result = await runAgent(config, `任务说明：${description}\n任务：${prompt}`, {
          smokeTool: false,
          generalPurposeSubagent: true,
          ...(approvalControl === undefined ? {} : { approvalControl }),
          ...(model === undefined ? {} : { modelOverride: model }),
          ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
        });
        return { report: result.text };
      }
      if (type !== 'explore') throw new ToolExecutionError(`未知子智能体类型“${subagent_type}”；可用类型：general-purpose、Explore。`, undefined);
      // TODO: 将 Explore 内部只读工具纳入工具策略与审批；当前仅外层 agent 调用受策略控制。
      const report = await runExplore(config, description, prompt, model, execution.abortSignal);
      return { report };
    },
  });
}
