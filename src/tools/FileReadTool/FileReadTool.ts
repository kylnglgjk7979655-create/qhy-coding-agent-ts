import { z } from 'zod';
import { readWorkspaceFile, resolveReadTarget } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerFileReadTool(registry: ToolRegistry, { config, fileBaselines, allowWorkspaceExternalRead = true, onFileRead }: BuiltInToolContext): void {
  registry.register({
    name: 'read_file',
    concurrency: 'parallel',
    description: '读取文件。工作区外文件需要审批。',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
    prepare: async ({ path }) => {
      const target = await resolveReadTarget(config.workspace, path);
      return { input: { path, target }, details: { requestedPath: path, target } };
    },
    execute: async ({ path, target }) => {
      const content = await readWorkspaceFile(
        config.workspace, path, fileBaselines, target, !allowWorkspaceExternalRead,
      );
      // 只在成功读取后刷新最近文件顺序；恢复读取不经过该工具。
      onFileRead?.(target);
      return { content };
    },
  });
}
