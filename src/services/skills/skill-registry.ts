import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PromptCommandRecord } from '../../cli/commands.js';

/** Skill 记录同时是 prompt 类型命令，并保留供清单展示的说明。 */
export interface SkillRecord extends PromptCommandRecord {
  readonly description: string;
}

/** 被跳过的 Skill 目录及原因，供 CLI 向用户展示可操作的诊断。 */
export interface SkillDiagnostic {
  /** Skill 目录或不可读的 Skill 根目录。 */
  readonly path: string;
  readonly reason: string;
}

export interface SkillCatalogue {
  readonly skills: readonly SkillRecord[];
  /** 拼装进系统指令的清单；正文不进入清单。 */
  readonly instructions: string;
  /** 本次加载跳过的目录；正常不存在的 Skill 根目录不产生诊断。 */
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillSource {
  /** 用户数据根目录。 */
  readonly home: string;
  /** 当前工作区。 */
  readonly workspace: string;
}

const projectSkillsDirectory = '.qhy-coding-agent/skills';
const globalSkillsDirectory = '.qhy-coding-agents/skills';

interface DirectoryLoadResult {
  readonly skills: readonly SkillRecord[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

/**
 * 从项目工作区与用户数据根目录注册 Skill。
 * 项目来源先注册，各来源内按目录名排序；无法解析、缺少必填字段或 SKILL.md
 * 不可读的目录被跳过并记录诊断，其余目录照常注册。
 */
export async function loadSkillCatalogue({ home, workspace }: SkillSource): Promise<SkillCatalogue> {
  const project = await loadFromDirectory(join(workspace, projectSkillsDirectory));
  const global = await loadFromDirectory(join(home, globalSkillsDirectory));
  const skills = [...project.skills, ...global.skills];
  return {
    skills,
    instructions: formatCatalogue(skills),
    diagnostics: [...project.diagnostics, ...global.diagnostics],
  };
}

async function loadFromDirectory(directory: string): Promise<DirectoryLoadResult> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // 根目录不存在属于正常情况，不产生噪声；其他读取失败应提示用户。
    if (isMissingPath(error)) return { skills: [], diagnostics: [] };
    return {
      skills: [],
      diagnostics: [{ path: directory, reason: `Skill 目录不可读（${errorMessage(error)}）` }],
    };
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareNames);
  const results = await Promise.all(names.map((name) => loadSkill(join(directory, name))));
  return {
    skills: results.flatMap((result) => ('skill' in result ? [result.skill] : [])),
    diagnostics: results.flatMap((result) => ('diagnostic' in result ? [result.diagnostic] : [])),
  };
}

type SkillLoadResult = { readonly skill: SkillRecord } | { readonly diagnostic: SkillDiagnostic };

async function loadSkill(directory: string): Promise<SkillLoadResult> {
  let content: string;
  try {
    content = await readFile(join(directory, 'SKILL.md'), 'utf8');
  } catch (error) {
    return { diagnostic: { path: directory, reason: `无法读取 SKILL.md（${errorMessage(error)}）` } };
  }
  const parsed = parseFrontmatter(content);
  if (parsed.error !== undefined) return { diagnostic: { path: directory, reason: parsed.error } };
  const { metadata } = parsed;
  const name = metadata.name?.trim() ?? '';
  const description = metadata.description?.trim() ?? '';
  const missing = [
    ...(name === '' ? ['name'] : []),
    ...(description === '' ? ['description'] : []),
  ];
  if (missing.length > 0) {
    return { diagnostic: { path: directory, reason: `缺少必填字段：${missing.join('、')}` } };
  }
  const body = skillBody(content);
  return {
    skill: {
      type: 'prompt',
      name,
      displayName: metadata.displayName?.trim() || name,
      aliases: metadata.aliases ?? [],
      description,
      // 正文在注册时读入且不含 frontmatter；之后来源文件变化不再影响该 Skill 记录。
      getPromptForCommand: () => body,
    },
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

type FrontmatterParseResult =
  | { readonly metadata: ParsedFrontmatter; readonly error?: undefined }
  | { readonly metadata?: undefined; readonly error: string };

function parseFrontmatter(content: string): FrontmatterParseResult {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { error: '缺少 frontmatter' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { error: 'frontmatter 未闭合' };

  let metadata: unknown;
  try {
    // 使用 YAML 语法校验整个 frontmatter；损坏的可选字段也应使目录被跳过。
    // failsafe 保留字符串标量语义，避免纯数字名称、别名被隐式转成其他类型。
    metadata = parse(lines.slice(1, end).join('\n'), { schema: 'failsafe' }) as unknown;
  } catch (error) {
    return { error: `frontmatter 格式无效：${errorMessage(error)}` };
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return { error: 'frontmatter 格式无效：应为键值对象' };
  }
  const fields = metadata as Record<string, unknown>;
  return {
    metadata: {
      name: asString(fields.name),
      description: asString(fields.description),
      displayName: asString(fields.display_name),
      aliases: asStringArray(fields.aliases),
    },
  };
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 取单行错误说明，避免多行 YAML 报错破坏 stderr 诊断的可读性。 */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0]?.trim() : '';
  return message || '未知错误';
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
