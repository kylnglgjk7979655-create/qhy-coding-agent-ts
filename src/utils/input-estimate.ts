import type { ModelMessage } from 'ai';

/**
 * 发送前的保守估算，并非服务端精确分词：覆盖序列化载荷及消息封装开销。
 * 上下文预算与 Skill 恢复预算共用同一估算方式，避免两处口径不一致。
 */
export function estimateInput(system: string, messages: readonly ModelMessage[], tools: unknown[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ system, messages, tools }), 'utf8') / 3)
    + 16 * (messages.length + 1);
}
