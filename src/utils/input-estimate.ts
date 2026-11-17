import { asSchema } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';

/**
 * 将工具集合展开为发送前估算使用的函数定义。
 * 主请求预算与 `/context` 共用，避免两处序列化口径漂移。
 */
export async function toolDefinitionsForEstimate(tools: ToolSet) {
  return Promise.all(Object.entries(tools).map(async ([name, definition]) => ({
    type: 'function',
    function: {
      name,
      description: definition.description,
      parameters: await asSchema(definition.inputSchema).jsonSchema,
    },
  })));
}

/**
 * 发送前的保守估算，并非服务端精确分词：覆盖序列化载荷及消息封装开销。
 * 上下文预算、`/context` 与 Skill 恢复预算共用同一估算方式，避免口径不一致。
 */
export function estimateInput(system: string, messages: readonly ModelMessage[], tools: unknown[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages, tools }), 'utf8') / 3)
    + 16 * (messages.length + 1);
}
