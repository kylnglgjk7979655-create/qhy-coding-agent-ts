import { z } from 'zod';
import { readWorkspaceFile } from '../workspace-files.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerFileReadTool(registry: ToolRegistry, { config }: BuiltInToolContext): void {
  registry.register({
    name: 'read_file',
    description: '读取工作区内的文本文件。',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
    execute: async ({ path }) => ({ content: await readWorkspaceFile(config.workspace, path) }),
  });
}
