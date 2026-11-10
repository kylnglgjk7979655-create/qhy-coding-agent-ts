import { z } from 'zod';
import { grepWorkspace, inspectWorkspaceSearch, validateSearchRoot } from '../workspace-search.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';
import { searchPathPermissionAction } from '../tool-approval.js';

export function registerGrepTool(registry: ToolRegistry, { config }: BuiltInToolContext): void {
  registry.register({
    name: 'grep',
    concurrency: 'parallel',
    description: '按正则搜索工作区文件，默认搜索整个工作区；可用 path 限定子目录、glob 限定文件。返回相对路径、行号和命中文本。包含隐藏目录并遵循 .gitignore。',
    inputSchema: z.strictObject({
      pattern: z.string().min(1).refine((pattern) => {
        try { new RegExp(pattern); return true; } catch { return false; }
      }),
      path: z.string().min(1).optional(),
      glob: z.string().min(1).optional(),
    }),
    prepare: async (input) => {
      const target = await validateSearchRoot(config.workspace, input.path);
      const permission = (path: string) => searchPathPermissionAction(config, 'grep', path);
      const rootDenied = permission(target) === 'deny';
      const scope = rootDenied ? { asks: [], excluded: [] } : await inspectWorkspaceSearch(config.workspace, input.path, permission);
      return { input: { ...input, approvedSearchAsks: scope.asks }, details: {
        requestedPath: input.path ?? '.', target,
        ...(scope.asks.length ? { searchAsk: JSON.stringify(scope.asks) } : {}),
      } };
    },
    execute: (input) => grepWorkspace(
      config.workspace,
      input,
      (path) => searchPathPermissionAction(config, 'grep', path),
      input.approvedSearchAsks,
    ),
  });
}
