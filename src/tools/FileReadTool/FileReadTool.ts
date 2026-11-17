import { z } from 'zod';
import { readWorkspaceFile, resolveReadTarget } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

/** 与 Claude Code Read 一致：未指定 limit 时最多返回前 2000 行。 */
const DEFAULT_READ_LIMIT = 2000;

export function registerFileReadTool(
  registry: ToolRegistry,
  { config, fileBaselines, allowWorkspaceExternalRead = true, onFileRead }: BuiltInToolContext,
  names: readonly ('read_file' | 'Read')[] = ['read_file', 'Read'],
): void {
  if (names.includes('read_file')) {
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

  if (names.includes('Read')) {
    registry.register({
      name: 'Read',
      concurrency: 'parallel',
      description: '读取文件。参数 file_path 为文件路径（相对路径从工作区解析），可选 offset（起始行，从 1 开始）和 limit（最多读取行数，默认 2000）；工作区外文件需要审批。',
      inputSchema: z.strictObject({
        file_path: z.string().min(1),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).optional(),
      }),
      prepare: async ({ file_path, offset, limit }) => {
        const target = await resolveReadTarget(config.workspace, file_path);
        return {
          input: { file_path, target, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) },
          details: { requestedPath: file_path, target },
        };
      },
      execute: async ({ file_path, target, offset, limit }) => {
        const content = await readWorkspaceFile(
          config.workspace, file_path, fileBaselines, target, !allowWorkspaceExternalRead,
        );
        onFileRead?.(target);
        const lines = content.split('\n');
        const startLine = offset ?? 1;
        const startIndex = startLine - 1;
        const selected = lines.slice(startIndex, startIndex + (limit ?? DEFAULT_READ_LIMIT));
        return {
          content: selected.join('\n'),
          startLine,
          numLines: selected.length,
          totalLines: lines.length,
          truncated: startIndex + selected.length < lines.length,
        };
      },
    });
  }
}
