import type { ModelMessage } from 'ai';
import { findCommand } from '../../cli/commands.js';
import { estimateInput } from '../../utils/input-estimate.js';
import type { SkillCatalogue, SkillRecord } from './skill-registry.js';

/** Skill 注入消息的标头前缀；同时用于在压缩时识别这类程序生成消息。 */
const injectionPrefix = 'Skill: ';

/** 单篇 Skill 正文的恢复预算（估算 token）；超出时从开头保留可容纳部分。 */
export const SKILL_RESTORE_PER_SKILL_TOKENS = 5_000;
/** 单次压缩恢复全部 Skill 正文的合计预算（估算 token）；最近加载者优先占用。 */
export const SKILL_RESTORE_TOTAL_TOKENS = 25_000;
/** 正文因预算限制省略时附加的标记；与其他恢复正文一样计入恢复预算。 */
export const SKILL_RESTORE_OMISSION_MARKER = '\n…（正文因恢复预算限制省略）';

export interface SkillRestoreBudget {
  readonly perSkillTokens: number;
  readonly totalTokens: number;
}

export const DEFAULT_SKILL_RESTORE_BUDGET: SkillRestoreBudget = {
  perSkillTokens: SKILL_RESTORE_PER_SKILL_TOKENS,
  totalTokens: SKILL_RESTORE_TOTAL_TOKENS,
};

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

/**
 * 注入消息是程序生成的指导内容，不参与轮次切分。
 * 标头后必须另有正文换行，避免把以 “Skill: ” 开头的普通用户消息误判为注入。
 */
export function isSkillInjectionMessage(message: ModelMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(injectionPrefix)
    && message.content.includes('\n');
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
 * 单篇与合计预算沿用上下文估算；超出时从正文开头保留可容纳部分并追加省略标记，
 * 省略标记计入预算，预算耗尽后不再恢复更早加载的 Skill。
 */
export function restoreSkillInjections(
  source: SkillRestoreSource,
  retained: readonly ModelMessage[],
  budget: SkillRestoreBudget = DEFAULT_SKILL_RESTORE_BUDGET,
): ModelMessage[] {
  const present = new Set(retained
    .map(skillInjectionName)
    .filter((name): name is string => name !== undefined));
  const restored: ModelMessage[] = [];
  let remaining = budget.totalTokens;
  for (let index = source.recentLoads.length - 1; index >= 0; index -= 1) {
    const name = source.recentLoads[index]!;
    if (present.has(name)) continue;
    const record = findByCanonicalName(source.catalogue, name);
    if (record === undefined) continue;
    present.add(name);
    const allowance = Math.min(budget.perSkillTokens, remaining);
    const full = skillInjectionMessage(record);
    const fullTokens = estimateMessageTokens(full);
    if (fullTokens <= allowance) {
      restored.push(full);
      remaining -= fullTokens;
      continue;
    }
    const truncated = truncateSkillInjection(record, allowance);
    // 连标头与省略标记都容纳不下时预算已耗尽，更早加载的 Skill 不再恢复。
    if (truncated === undefined) break;
    restored.push(truncated);
    remaining -= estimateMessageTokens(truncated);
  }
  return restored;
}

/** 按与上下文一致的估算方式计算单条注入消息的预算占用。 */
function estimateMessageTokens(message: ModelMessage): number {
  return estimateInput('', [message], []);
}

/**
 * 在预算内从正文开头截取并保留 `Skill: <规范名称>` 标头与省略标记。
 * 使用二分查找，保证截断结果按同一估算方式不超过给定预算。
 */
function truncateSkillInjection(record: SkillRecord, allowanceTokens: number): ModelMessage | undefined {
  const header = `${injectionPrefix}${record.name}\n`;
  const body = record.getPromptForCommand();
  const fits = (length: number): boolean => estimateMessageTokens({
    role: 'user',
    content: `${header}${body.slice(0, length)}${SKILL_RESTORE_OMISSION_MARKER}`,
  }) <= allowanceTokens;
  if (!fits(0)) return undefined;
  let low = 0;
  let high = body.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  // 避免把代理对截成半个码点。
  const last = body.charCodeAt(low - 1);
  const end = low > 0 && last >= 0xd800 && last <= 0xdbff ? low - 1 : low;
  return { role: 'user', content: `${header}${body.slice(0, end)}${SKILL_RESTORE_OMISSION_MARKER}` };
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
  // 同名 Skill 可来自不同来源；用调用时的原始标识还原工具真正命中的记录。
  const callInputs = skillCallInputs(messages);
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      if (part.toolName !== 'skill' || injected.has(part.toolCallId)) continue;
      const record = resolveSkill(catalogue, part.output, callInputs.get(part.toolCallId));
      if (record === undefined) continue;
      injected.add(part.toolCallId);
      collected.push({ toolCallId: part.toolCallId, name: record.name, message: skillInjectionMessage(record) });
    }
  }
  return collected;
}

/** 从本轮响应中的 Skill 工具调用取回输入，按调用 ID 保存。 */
function skillCallInputs(messages: readonly ModelMessage[]): Map<string, unknown> {
  const inputs = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'skill') continue;
      inputs.set(part.toolCallId, part.input);
    }
  }
  return inputs;
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

function resolveSkill(catalogue: SkillCatalogue, output: unknown, input: unknown): SkillRecord | undefined {
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
  // 优先按调用时的标识重新查找，保证同名 Skill 注入的是工具实际命中的那一条记录。
  if (typeof input === 'object' && input !== null) {
    const requested = (input as { name?: unknown }).name;
    if (typeof requested === 'string') {
      const matched = findCommand(catalogue.skills, requested);
      if (matched !== undefined && matched.name === name) return matched;
    }
  }
  // 调用记录缺少输入时回退到规范名称；同名记录按注册顺序取第一个，与工具查找一致。
  return findByCanonicalName(catalogue, name);
}

/** 按规范名称查找 Skill；同名记录按注册顺序取第一个。 */
function findByCanonicalName(catalogue: SkillCatalogue, name: string): SkillRecord | undefined {
  return catalogue.skills.find((skill) => skill.name === name);
}
