import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

  const fields = new Map<string, string | string[]>();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!.trim();
    if (raw === '') {
      const block = readList(lines, index + 1, end);
      if (!block) continue;
      fields.set(key, block.values);
      index = block.next - 1;
      continue;
    }
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
      const block = readBlockScalar(lines, index + 1, end, raw.startsWith('|'));
      fields.set(key, block.text);
      index = block.next - 1;
      continue;
    }
    fields.set(key, parseValue(raw));
  }

  return {
    name: asString(fields.get('name')),
    description: asString(fields.get('description')),
    displayName: asString(fields.get('display_name')),
    aliases: asStringArray(fields.get('aliases')),
  };
}

interface ListBlock {
  values: string[];
  next: number;
}

function readList(lines: readonly string[], start: number, end: number): ListBlock | undefined {
  const values: string[] = [];
  let index = start;
  for (; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (!/^\s+/.test(line)) break;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) break;
    values.push(parseScalar(item[1]!));
  }
  return values.length === 0 ? undefined : { values, next: index };
}

interface BlockScalar {
  text: string;
  next: number;
}

function readBlockScalar(lines: readonly string[], start: number, end: number, literal: boolean): BlockScalar {
  const collected: string[] = [];
  let index = start;
  for (; index < end; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s+/.test(line)) break;
    collected.push(line.trim());
  }
  return { text: literal ? collected.join('\n') : collected.join(' '), next: index };
}

function parseValue(raw: string): string | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitInlineArray(raw.slice(1, -1)).map(parseScalar).filter(Boolean);
  }
  return parseScalar(raw);
}

function splitInlineArray(raw: string): string[] {
  const values: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of raw) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch {
      // 非标准转义时退回去除外层引号。
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    const aliases = value.split(',').map((alias) => alias.trim()).filter(Boolean);
    return aliases.length === 0 ? undefined : aliases;
  }
  return undefined;
}
