import { z } from 'zod';
import { grepWorkspace, validateSearchRoot } from '../workspace-search.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerGrepTool(registry: ToolRegistry, { config }: BuiltInToolContext): void {
  registry.register({
    name: 'grep',
    description: '按正则搜索工作区文件，默认搜索整个工作区；可用 path 限定子目录、glob 限定文件。返回相对路径、行号和命中文本。包含隐藏目录并遵循 .gitignore。',
    inputSchema: z.strictObject({
      pattern: z.string().min(1).refine((pattern) => {
        try { new RegExp(pattern); return true; } catch { return false; }
      }),
      path: z.string().min(1).optional(),
      glob: z.string().min(1).optional(),
    }),
    prepare: async (input) => {
      await validateSearchRoot(config.workspace, input.path);
      return { input };
    },
    execute: (input) => grepWorkspace(config.workspace, input),
  });
}
