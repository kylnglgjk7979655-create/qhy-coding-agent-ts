import { z } from 'zod';
import { grepWorkspace, inspectWorkspaceSearch, validateSearchRoot } from '../workspace-search.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';
import { searchPathAction, toPermissionRuleSet } from '../tool-permission-policy.js';

export function registerGrepTool(
  registry: ToolRegistry,
  { config }: BuiltInToolContext,
  names: readonly ('grep' | 'Grep')[] = ['grep', 'Grep'],
): void {
  const rules = toPermissionRuleSet(config.permissions);
  // 搜索根与遍历剪枝共用同一份规则事实，避免准备阶段与执行阶段出现分歧。
  const permission = (path: string) => searchPathAction({
    rules, workspace: config.workspace, capability: 'Grep', path,
  });
  const register = (name: string): void => {
    registry.register({
      name,
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
        const rootDenied = permission(target) === 'deny';
        const scope = rootDenied ? { asks: [], excluded: [] } : await inspectWorkspaceSearch(config.workspace, input.path, permission);
        return {
          input: { ...input, approvedSearchAsks: scope.asks, approvedSearchRoot: target },
          details: {
            requestedPath: input.path ?? '.', target,
            ...(scope.asks.length ? { searchAsk: JSON.stringify(scope.asks) } : {}),
          },
          permission: { tool: 'grep', requestedPath: input.path ?? '.', target, searchAsks: scope.asks },
        };
      },
      execute: (input) => grepWorkspace(
        config.workspace,
        input,
        permission,
        input.approvedSearchAsks,
        input.approvedSearchRoot,
      ),
    });
  };
  for (const name of names) register(name);
}
