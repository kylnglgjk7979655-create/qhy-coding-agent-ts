import { z } from 'zod';
import { writeWorkspaceFile } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerFileWriteTool(registry: ToolRegistry, { config, options }: BuiltInToolContext): void {
  registry.register({
    name: 'write_file',
    description: '将工作区内文件完整替换为指定内容；目标不存在时创建文件，不会创建父目录。',
    inputSchema: z.strictObject({ path: z.string().min(1), content: z.string() }),
    execute: async ({ path, content }) => {
      await writeWorkspaceFile(
        config.workspace,
        path,
        content,
        options.onBeforeWrite,
        options.onCheckpointError,
      );
      return { success: true as const };
    },
  });
}
