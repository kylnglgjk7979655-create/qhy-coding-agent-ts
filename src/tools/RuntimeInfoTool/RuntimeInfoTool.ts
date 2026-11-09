import { z } from 'zod';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerRuntimeInfoTool(registry: ToolRegistry, { config, probe }: BuiltInToolContext): void {
  registry.register({
    name: 'runtimeInfo',
    description: '返回已配置的工作区绝对路径和本次运行探针。',
    inputSchema: z.object({}),
    execute: () => ({ workspace: config.workspace, probe }),
  });
}
