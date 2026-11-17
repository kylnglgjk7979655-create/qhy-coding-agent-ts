import { z } from 'zod';
import type { ToolRegistry } from '../tool-registry.js';

const todoSchema = z.strictObject({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1).optional(),
});
export type TodoItem = z.infer<typeof todoSchema>;

export function registerTodoWriteTool(registry: ToolRegistry): void {
  // 每次 runAgent 注册一份，状态只在本次 Agent 运行内有效；调用以完整列表替换旧状态。
  let todos: TodoItem[] = [];
  registry.register({
    name: 'TodoWrite',
    description: '创建或完整更新本次任务的待办列表。todos 为完整新列表，会替换旧列表；最多一个任务处于 in_progress。',
    inputSchema: z.strictObject({ todos: z.array(todoSchema) }),
    execute: ({ todos: next }) => {
      if (next.filter(({ status }) => status === 'in_progress').length > 1) {
        throw new Error('最多允许一个待办处于 in_progress。');
      }
      todos = next.map((todo) => ({ ...todo }));
      return { todos: todos.map((todo) => ({ ...todo })), count: todos.length };
    },
  });
}
