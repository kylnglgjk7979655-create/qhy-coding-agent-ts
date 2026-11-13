import type { ModelMessage } from 'ai';
import type { SkillCatalogue, SkillRecord } from './skill-registry.js';

/** Skill 注入消息的标头前缀；同时用于在压缩时识别这类程序生成消息。 */
const injectionPrefix = 'Skill: ';

export interface SkillInjection {
  readonly toolCallId: string;
  /** 命中的 Skill 规范名称，用于记录最近加载顺序。 */
  readonly name: string;
  readonly message: ModelMessage;
}

/** 注入消息由规范名称标头和注册时读入的正文组成。 */
export function skillInjectionMessage(record: SkillRecord): ModelMessage {
  return { role: 'user', content: `${injectionPrefix}${record.name}\n${record.getPromptForCommand()}` };
}

/** 注入消息是程序生成的指导内容，不参与轮次切分。 */
export function isSkillInjectionMessage(message: ModelMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(injectionPrefix);
}

/** 取注入消息的 Skill 规范名称；非注入消息或缺少标头时返回 undefined。 */
function skillInjectionName(message: ModelMessage): string | undefined {
  if (!isSkillInjectionMessage(message)) return undefined;
  const content = (message as { content: string }).content;
  const header = content.slice(injectionPrefix.length);
  const lineEnd = header.indexOf('\n');
  const name = (lineEnd < 0 ? header : header.slice(0, lineEnd)).trim();
  return name === '' ? undefined : name;
}

/** 压缩恢复所需的 Skill 来源：注册清单与按加载顺序排列的规范名称（最近的在末尾）。 */
export interface SkillRestoreSource {
  readonly catalogue: SkillCatalogue;
  readonly recentLoads: readonly string[];
}

/**
 * 压缩后恢复被摘要移除的 Skill 正文：按最近加载顺序（最近优先）生成注入消息。
 * 正文仍在保留历史中的 Skill 不重复添加；清单中找不到对应记录时跳过。
 */
export function restoreSkillInjections(source: SkillRestoreSource, retained: readonly ModelMessage[]): ModelMessage[] {
  const present = new Set(retained
    .map(skillInjectionName)
    .filter((name): name is string => name !== undefined));
  const restored: ModelMessage[] = [];
  for (let index = source.recentLoads.length - 1; index >= 0; index -= 1) {
    const name = source.recentLoads[index]!;
    if (present.has(name)) continue;
    const record = source.catalogue.skills.find((skill) => skill.name === name);
    if (record === undefined) continue;
    present.add(name);
    restored.push(skillInjectionMessage(record));
  }
  return restored;
}

/**
 * 从本轮新增消息中收集尚未注入的成功 Skill 调用，按调用顺序生成注入消息。
 * 调用方传入已注入的调用 ID，避免后续步骤或压缩后重复注入。
 */
export function collectSkillInjections(
  catalogue: SkillCatalogue,
  messages: readonly ModelMessage[],
  injected: Set<string>,
): SkillInjection[] {
  const collected: SkillInjection[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      if (part.toolName !== 'skill' || injected.has(part.toolCallId)) continue;
      const record = resolveSkill(catalogue, part.output);
      if (record === undefined) continue;
      injected.add(part.toolCallId);
      collected.push({ toolCallId: part.toolCallId, name: record.name, message: skillInjectionMessage(record) });
    }
  }
  return collected;
}

/** 按最近加载顺序合并 Skill 规范名称；同一 Skill 重复加载只保留最近一次位置。 */
export function appendRecentSkillLoads(existing: readonly string[], added: readonly string[]): string[] {
  const merged = [...existing];
  for (const name of added) {
    const previous = merged.lastIndexOf(name);
    if (previous >= 0) merged.splice(previous, 1);
    merged.push(name);
  }
  return merged;
}

/** 把注入消息插到对应工具结果之后；找不到锚点时追加到末尾，避免丢失正文。 */
export function insertSkillInjections(messages: readonly ModelMessage[], injections: readonly SkillInjection[]): ModelMessage[] {
  const pending = new Map(injections.map(({ toolCallId, message }) => [toolCallId, message]));
  const result: ModelMessage[] = [];
  for (const message of messages) {
    result.push(message);
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      const injection = pending.get(part.toolCallId);
      if (injection === undefined) continue;
      pending.delete(part.toolCallId);
      result.push(injection);
    }
  }
  result.push(...pending.values());
  return result;
}

function resolveSkill(catalogue: SkillCatalogue, output: unknown): SkillRecord | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const envelope = output as { type?: unknown; value?: unknown };
  // ModelMessage 的工具结果是带类型信封的值；工具原始返回保存在 value 中。
  if (envelope.type !== 'json') return undefined;
  const value = envelope.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const result = value as { is_error?: unknown; output?: unknown };
  if (result.is_error !== false || typeof result.output !== 'object' || result.output === null) return undefined;
  const name = (result.output as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;
  // 工具结果返回的是规范名称；同名记录按注册顺序取第一个，与工具查找一致。
  return catalogue.skills.find((record) => record.name === name);
}