import { z } from 'zod';
import { resolveWriteTarget, writeControlledWorkspaceFile } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerFileWriteTool(registry: ToolRegistry, { config, fileWriteCallbacks, fileBaselines }: BuiltInToolContext): void {
  const baselines = fileBaselines ?? new Map();
  registry.register({
    name: 'write_file',
    description: '将文件完整替换为指定内容；工作区外写入需要审批，目标不存在时创建文件，不会创建父目录。',
    inputSchema: z.strictObject({ path: z.string().min(1), content: z.string() }),
    prepare: async ({ path, content }) => {
      const target = await resolveWriteTarget(config.workspace, path);
      return { input: { path, content, target }, details: { requestedPath: path, target } };
    },
    execute: async ({ path, content, target }) => {
      await writeControlledWorkspaceFile(
        config.workspace,
        path,
        content,
        baselines,
        fileWriteCallbacks.onBeforeWrite,
        fileWriteCallbacks.onCheckpointError,
        target,
      );
      return { success: true as const };
    },
  });

  registry.register({
    name: 'Write',
    description: '将文件创建或完整重写为指定内容；参数 file_path 与 content。工作区外写入需要审批，不会创建父目录。',
    inputSchema: z.strictObject({ file_path: z.string().min(1), content: z.string() }),
    prepare: async ({ file_path, content }) => {
      const target = await resolveWriteTarget(config.workspace, file_path);
      return { input: { file_path, content, target }, details: { requestedPath: file_path, target } };
    },
    execute: async ({ file_path, content, target }) => {
      // Claude 风格的 Write 允许直接创建或重写目标；同进程并发写入仍按读取基线检测冲突。
      await writeControlledWorkspaceFile(
        config.workspace,
        file_path,
        content,
        baselines,
        fileWriteCallbacks.onBeforeWrite,
        fileWriteCallbacks.onCheckpointError,
        target,
        true,
      );
      return { success: true as const, file_path };
    },
  });
}
