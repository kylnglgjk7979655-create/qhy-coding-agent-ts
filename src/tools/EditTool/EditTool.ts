import { z } from 'zod';
import { editControlledWorkspaceFile, resolveWriteTarget } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerEditTool(registry: ToolRegistry, { config, fileWriteCallbacks, fileBaselines }: BuiltInToolContext): void {
  const baselines = fileBaselines ?? new Map();
  registry.register({
    name: 'Edit',
    description: '在单个文件中把 old_string 替换为 new_string。默认要求 old_string 在文件中唯一匹配；replace_all: true 时替换全部匹配。无匹配或多处匹配且未启用 replace_all 时失败且不修改文件。',
    inputSchema: z.strictObject({
      file_path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
    }),
    prepare: async ({ file_path, old_string, new_string, replace_all }) => {
      const target = await resolveWriteTarget(config.workspace, file_path);
      return {
        input: { file_path, old_string, new_string, replace_all, target },
        details: { requestedPath: file_path, target },
      };
    },
    execute: async ({ file_path, old_string, new_string, replace_all, target }) => {
      const replacements = await editControlledWorkspaceFile(
        config.workspace,
        file_path,
        old_string,
        new_string,
        replace_all,
        baselines,
        fileWriteCallbacks.onBeforeWrite,
        fileWriteCallbacks.onCheckpointError,
        target,
        true,
      );
      return { success: true as const, file_path, replacements };
    },
  });
}
