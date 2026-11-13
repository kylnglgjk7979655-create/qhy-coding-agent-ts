import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PromptCommandRecord } from '../../cli/commands.js';

/** Skill 记录同时是 prompt 类型命令，并保留供清单展示的说明。 */
export interface SkillRecord extends PromptCommandRecord {
  readonly description: string;
}

export interface SkillCatalogue {
  readonly skills: readonly SkillRecord[];
  /** 拼装进系统指令的清单；正文不进入清单。 */
  readonly instructions: string;
}

export interface SkillSource {
  /** 用户数据根目录。 */
  readonly home: string;
  /** 当前工作区。 */
  readonly workspace: string;
}

const projectSkillsDirectory = '.qhy-coding-agent/skills';
const globalSkillsDirectory = '.qhy-coding-agents/skills';

/**
 * 从项目工作区与用户数据根目录注册 Skill。
 * 项目来源先注册，各来源内按目录名排序；无法解析或缺少说明的目录直接跳过。
 */
export async function loadSkillCatalogue({ home, workspace }: SkillSource): Promise<SkillCatalogue> {
  const skills = [
    ...await loadFromDirectory(join(workspace, projectSkillsDirectory)),
    ...await loadFromDirectory(join(home, globalSkillsDirectory)),
  ];
  return { skills, instructions: formatCatalogue(skills) };
}

async function loadFromDirectory(directory: string): Promise<SkillRecord[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // Skill 目录不存在或不可读时不影响启动。
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareNames);
  const records = await Promise.all(names.map((name) => loadSkill(join(directory, name))));
  return records.filter((record): record is SkillRecord => record !== undefined);
}

async function loadSkill(directory: string): Promise<SkillRecord | undefined> {
  let content: string;
  try {
    content = await readFile(join(directory, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
  const metadata = parseFrontmatter(content);
  const name = metadata.name?.trim();
  const description = metadata.description?.trim();
  if (!name || !description) return undefined;
  const body = skillBody(content);
  return {
    type: 'prompt',
    name,
    displayName: metadata.displayName?.trim() || name,
    aliases: metadata.aliases ?? [],
    description,
    // 正文在注册时读入且不含 frontmatter；之后来源文件变化不再影响该 Skill 记录。
    getPromptForCommand: () => body,
  };
}

/** 正文从 frontmatter 结束行之后开始；没有 frontmatter 时整篇都是正文。 */
function skillBody(content: string): string {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return content;
  const body = lines.slice(end + 1).join('\n');
  // frontmatter 与正文之间常见一个空行，注入时只保留正文本身。
  return body.startsWith('\n') ? body.slice(1) : body;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function formatCatalogue(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) return '';
  return [
    '可用 Skill（名称：说明；需要时加载正文）：',
    ...skills.map(({ name, description }) => `- ${name}：${description}`),
  ].join('\n');
}

interface ParsedFrontmatter {
  name?: string | undefined;
  description?: string | undefined;
  displayName?: string | undefined;
  aliases?: string[] | undefined;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return {};

  let metadata: unknown;
  try {
    // 使用 YAML 语法校验整个 frontmatter；损坏的可选字段也应使目录被跳过。
    // failsafe 保留字符串标量语义，避免纯数字名称、别名被隐式转成其他类型。
    metadata = parse(lines.slice(1, end).join('\n'), { schema: 'failsafe' }) as unknown;
  } catch {
    return {};
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return {};
  const fields = metadata as Record<string, unknown>;
  return {
    name: asString(fields.name),
    description: asString(fields.description),
    displayName: asString(fields.display_name),
    aliases: asStringArray(fields.aliases),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0);
  if (typeof value === 'string') {
    const aliases = value.split(',').map((alias) => alias.trim()).filter(Boolean);
    return aliases.length === 0 ? undefined : aliases;
  }
  return undefined;
}
