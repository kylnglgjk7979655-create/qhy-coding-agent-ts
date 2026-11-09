import { z } from 'zod';
import type { ResolvedConfig } from '../../services/settings/config.js';
import { runExplore } from '../../query/explore.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerAgentTool(registry: ToolRegistry, config: ResolvedConfig): void {
  registry.register({
    name: 'agent',
    description: '将只读代码调查委派给 Explore。提供简短任务说明和具体调查 prompt；subagent_type 可省略，当前支持 Explore；model 可指定本次调用的模型。',
    inputSchema: z.strictObject({
      description: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
      subagent_type: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
    }),
    execute: async ({ description, prompt, subagent_type, model }, execution) => {
      if (subagent_type !== undefined && subagent_type.toLowerCase() !== 'explore') {
        throw new ToolExecutionError(`未知子智能体类型“${subagent_type}”；可用类型：Explore。`, undefined);
      }
      // TODO: 将 Explore 内部只读工具纳入工具策略与审批；当前仅外层 agent 调用受策略控制。
      const report = await runExplore(config, description, prompt, model, execution.abortSignal);
      return { report };
    },
  });
}
