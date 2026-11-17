import { z } from 'zod';
import { globWorkspace, inspectWorkspaceSearch, validateSearchRoot } from '../workspace-search.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';
import { searchPathAction } from '../tool-permission-policy.js';

export function registerGlobTool(
  registry: ToolRegistry,
  { config }: BuiltInToolContext,
  names: readonly ('glob' | 'Glob')[] = ['glob', 'Glob'],
): void {
  const rules = {
    allow: config.permissions?.allow ?? [], ask: config.permissions?.ask ?? [], deny: config.permissions?.deny ?? [],
  };
  const register = (name: string): void => {
    registry.register({
      name,
      concurrency: 'parallel',
      description: '按 glob 模式查找工作区文件，默认搜索整个工作区；可用 path 限定子目录。包含隐藏目录并遵循 .gitignore。',
      inputSchema: z.strictObject({ pattern: z.string().min(1), path: z.string().min(1).optional() }),
      prepare: async (input) => {
        const target = await validateSearchRoot(config.workspace, input.path);
        const permission = (path: string) => searchPathAction({
          rules, workspace: config.workspace, capability: 'Glob', path,
        });
        const rootDenied = permission(target) === 'deny';
        const scope = rootDenied ? { asks: [], excluded: [] } : await inspectWorkspaceSearch(config.workspace, input.path, permission);
        return {
          input: { ...input, approvedSearchAsks: scope.asks, approvedSearchRoot: target },
          details: {
            requestedPath: input.path ?? '.', target,
            ...(scope.asks.length ? { searchAsk: JSON.stringify(scope.asks) } : {}),
          },
          permission: { tool: 'glob', requestedPath: input.path ?? '.', target, searchAsks: scope.asks },
        };
      },
      execute: (input) => globWorkspace(
        config.workspace,
        input,
        (path) => searchPathAction({ rules, workspace: config.workspace, capability: 'Glob', path }),
        input.approvedSearchAsks,
        input.approvedSearchRoot,
      ),
    });
  };
  for (const name of names) register(name);
}
