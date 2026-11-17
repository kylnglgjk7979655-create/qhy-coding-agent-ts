import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { matchesCommandPattern } from './BashTool/bash-policy.js';
import { isWithinWorkspace } from './workspace-files.js';

/**
 * 工具权限策略：把规则解析、事实匹配、默认权限与优先级收敛在单一模块。
 * 本模块只判断权限结论，不执行人工/模型审批，也不生成审批展示文本。
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';

export type PermissionCapability =
  | 'Read' | 'Write' | 'Edit' | 'Glob' | 'Grep' | 'Bash' | 'MCP'
  | 'Agent' | 'RuntimeInfo' | 'TodoWrite' | 'WebFetch' | 'WebSearch';

export interface PermissionRuleSet {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

/** 配置中的权限列表到策略输入的规范形；省略 permissions 时视为空规则。 */
export function toPermissionRuleSet(permissions: {
  readonly allow?: readonly string[] | undefined;
  readonly ask?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
} | undefined): PermissionRuleSet {
  return {
    allow: permissions?.allow ?? [],
    ask: permissions?.ask ?? [],
    deny: permissions?.deny ?? [],
  };
}

export interface ParsedPermissionRule {
  readonly capability: PermissionCapability;
  readonly argument?: string;
}

/**
 * 工具在 prepare 阶段提供的权限事实；不包含用户可见展示文本。
 * `tool` 是策略语义分类，不是注册工具名：Read/read_file 都归为 read_file。
 */
export type ToolPermissionFacts =
  | { readonly tool: 'read_file'; readonly requestedPath: string; readonly target: string }
  | { readonly tool: 'write_file'; readonly requestedPath: string; readonly target: string }
  | { readonly tool: 'edit'; readonly requestedPath: string; readonly target: string }
  | { readonly tool: 'glob' | 'grep';
      readonly requestedPath: string; readonly target: string; readonly searchAsks: readonly string[] }
  | { readonly tool: 'Bash'; readonly commands: readonly string[]; readonly requiresExtraApproval: boolean }
  | { readonly tool: 'mcp'; readonly server: string; readonly remoteTool: string }
  | { readonly tool: 'agent' | 'runtimeInfo' | 'skill' }
  | { readonly tool: 'webFetch'; readonly hostname?: string }
  | { readonly tool: 'webSearch' }
  | { readonly tool: 'todoWrite' };

export interface PermissionDecision {
  readonly outcome: PermissionAction;
  /** 结论来源：rule 表示规则命中，其余为不同默认审批条件。 */
  readonly reason: 'rule' | 'default' | 'outside-workspace' | 'search-scope' | 'bash-extra-approval';
}

const PATH_CAPABILITIES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
type PathCapability = (typeof PATH_CAPABILITIES)[number];
const PERMISSION_ACTIONS = ['deny', 'ask', 'allow'] as const;

const rulePattern = /^(Read|Write|Edit|Glob|Grep|Bash|MCP|Agent|RuntimeInfo|TodoWrite|WebFetch|WebSearch)(?:\(([^()]+)\))?$/u;
const mcpArgumentPattern = /^[a-z][a-z0-9-]{0,15}\/(?:\*|[^\s()*][^\s()]*)$/u;
const webFetchArgumentPattern = /^domain:\S+$/u;

/** 配置校验与运行时匹配共用的唯一规则解析入口；非法规则返回 undefined。 */
export function parsePermissionRule(raw: string): ParsedPermissionRule | undefined {
  const match = rulePattern.exec(raw);
  if (!match) return undefined;
  const capability = match[1] as PermissionCapability;
  const argument = match[2];
  switch (capability) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
    case 'Grep':
      // 路径规则可省略参数（表示整个能力），带参数时不能只剩空白。
      if (argument !== undefined && argument.trim().length === 0) return undefined;
      break;
    case 'Bash':
      if (argument === undefined || argument.trim().length === 0) return undefined;
      break;
    case 'MCP':
      if (argument !== undefined && !mcpArgumentPattern.test(argument)) return undefined;
      break;
    case 'WebFetch':
      if (argument !== undefined && !webFetchArgumentPattern.test(argument)) return undefined;
      break;
    default:
      if (argument !== undefined) return undefined;
  }
  return { capability, ...(argument === undefined ? {} : { argument }) };
}

/** 搜索遍历按候选路径剪枝时使用；只做路径规则匹配，不进入审批编排。 */
export function searchPathAction(input: {
  readonly rules: PermissionRuleSet;
  readonly workspace: string;
  readonly capability: 'Glob' | 'Grep';
  readonly path: string;
}): PermissionAction | undefined {
  const absolutePath = canonicalizePermissionPath(resolve(input.path));
  const matches = (rule: string): boolean => {
    const parsed = parsePermissionRule(rule);
    return parsed !== undefined && parsed.capability === input.capability
      && pathRuleMatches(parsed, input.workspace, [absolutePath]);
  };
  return firstMatchingAction(input.rules, matches);
}

export function evaluatePermission(input: {
  readonly rules: PermissionRuleSet;
  readonly workspace: string;
  readonly facts: ToolPermissionFacts;
}): PermissionDecision {
  const { rules, workspace, facts } = input;
  switch (facts.tool) {
    case 'read_file': {
      const action = pathAction(rules, workspace, ['Read'], facts.requestedPath, facts.target);
      if (action !== undefined) return { outcome: action, reason: 'rule' };
      return isWithinWorkspace(workspace, facts.target)
        ? { outcome: 'allow', reason: 'default' }
        : { outcome: 'ask', reason: 'outside-workspace' };
    }
    case 'write_file': {
      const action = pathAction(rules, workspace, ['Write'], facts.requestedPath, facts.target);
      return action === undefined ? { outcome: 'ask', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'edit': {
      // Edit 同时受 Edit 与 Write 规则约束，避免用户配置的 Edit(...) 规则被静默忽略。
      const action = pathAction(rules, workspace, ['Edit', 'Write'], facts.requestedPath, facts.target);
      return action === undefined ? { outcome: 'ask', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'glob':
    case 'grep': {
      const capability = facts.tool === 'glob' ? 'Glob' : 'Grep';
      const action = pathAction(rules, workspace, [capability], facts.requestedPath, facts.target);
      if (action === 'deny') return { outcome: 'deny', reason: 'rule' };
      if (action === 'ask') return { outcome: 'ask', reason: 'rule' };
      if (facts.searchAsks.length > 0) return { outcome: 'ask', reason: 'search-scope' };
      if (action === 'allow') return { outcome: 'allow', reason: 'rule' };
      return isWithinWorkspace(workspace, facts.target)
        ? { outcome: 'allow', reason: 'default' }
        : { outcome: 'ask', reason: 'outside-workspace' };
    }
    case 'Bash': {
      const actions = facts.commands.map((command) => bashAction(rules, command));
      if (actions.includes('deny')) return { outcome: 'deny', reason: 'rule' };
      if (actions.includes('ask')) return { outcome: 'ask', reason: 'rule' };
      if (actions.length > 0 && actions.every((action) => action === 'allow')) {
        return facts.requiresExtraApproval
          ? { outcome: 'ask', reason: 'bash-extra-approval' }
          : { outcome: 'allow', reason: 'rule' };
      }
      return facts.requiresExtraApproval
        ? { outcome: 'ask', reason: 'bash-extra-approval' }
        : { outcome: 'ask', reason: 'default' };
    }
    case 'mcp': {
      const action = mcpAction(rules, facts.server, facts.remoteTool);
      return action === undefined ? { outcome: 'ask', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'agent':
    case 'runtimeInfo': {
      const capability = facts.tool === 'agent' ? 'Agent' : 'RuntimeInfo';
      const action = capabilityAction(rules, capability);
      return action === undefined ? { outcome: 'allow', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'todoWrite': {
      const action = capabilityAction(rules, 'TodoWrite');
      return action === undefined ? { outcome: 'allow', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'webSearch': {
      const action = capabilityAction(rules, 'WebSearch');
      return action === undefined ? { outcome: 'ask', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'webFetch': {
      const action = firstMatchingAction(rules, (rule) => webFetchRuleMatches(rule, facts.hostname));
      return action === undefined ? { outcome: 'ask', reason: 'default' } : { outcome: action, reason: 'rule' };
    }
    case 'skill':
      // Skill 没有对应规则能力，始终沿用工具默认允许。
      return { outcome: 'allow', reason: 'default' };
  }
}

function firstMatchingAction(
  rules: PermissionRuleSet,
  matches: (rule: string) => boolean,
): PermissionAction | undefined {
  for (const action of PERMISSION_ACTIONS) {
    if (rules[action].some(matches)) return action;
  }
  return undefined;
}

function capabilityAction(rules: PermissionRuleSet, capability: PermissionCapability): PermissionAction | undefined {
  return firstMatchingAction(rules, (rule) => {
    const parsed = parsePermissionRule(rule);
    return parsed !== undefined && parsed.capability === capability && parsed.argument === undefined;
  });
}

function pathAction(
  rules: PermissionRuleSet,
  workspace: string,
  capabilities: readonly PathCapability[],
  requestedPath: string,
  target: string,
): PermissionAction | undefined {
  const paths = [resolveUserPath(workspace, requestedPath), target].map(canonicalizePermissionPath);
  return firstMatchingAction(rules, (rule) => {
    const parsed = parsePermissionRule(rule);
    return parsed !== undefined
      && isPathCapability(parsed.capability)
      && capabilities.includes(parsed.capability)
      && pathRuleMatches(parsed, workspace, paths);
  });
}

/** 路径规则同时匹配请求路径与解析后的实际目标；省略参数时匹配整个能力。 */
function pathRuleMatches(
  parsed: ParsedPermissionRule,
  workspace: string,
  paths: readonly string[],
): boolean {
  if (parsed.argument === undefined) return true;
  const pattern = canonicalizePermissionPath(resolveUserPath(workspace, parsed.argument));
  const expression = globExpression(pattern);
  return paths.some((path) => expression.test(path));
}

function isPathCapability(capability: PermissionCapability): capability is PathCapability {
  return (PATH_CAPABILITIES as readonly PermissionCapability[]).includes(capability);
}

function bashAction(rules: PermissionRuleSet, command: string): PermissionAction | undefined {
  return firstMatchingAction(rules, (rule) => {
    const parsed = parsePermissionRule(rule);
    return parsed !== undefined && parsed.capability === 'Bash'
      && parsed.argument !== undefined
      && matchesCommandPattern(parsed.argument.trim(), command);
  });
}

function mcpAction(rules: PermissionRuleSet, server: string, remoteTool: string): PermissionAction | undefined {
  return firstMatchingAction(rules, (rule) => {
    const parsed = parsePermissionRule(rule);
    if (parsed === undefined || parsed.capability !== 'MCP') return false;
    if (parsed.argument === undefined) return true;
    const separator = parsed.argument.indexOf('/');
    const ruleServer = parsed.argument.slice(0, separator);
    const ruleTool = parsed.argument.slice(separator + 1);
    if (ruleServer !== server) return false;
    return ruleTool === '*' || ruleTool === remoteTool;
  });
}

function webFetchRuleMatches(rule: string, hostname: string | undefined): boolean {
  const parsed = parsePermissionRule(rule);
  if (parsed === undefined || parsed.capability !== 'WebFetch') return false;
  if (parsed.argument === undefined) return true;
  if (hostname === undefined) return false;
  const pattern = parsed.argument.slice('domain:'.length).toLowerCase();
  return globExpression(pattern).test(hostname.toLowerCase());
}

/** 相对路径从工作区解析；`~` 与 `~/...` 展开为用户目录。 */
function resolveUserPath(workspace: string, path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
  return resolve(workspace, expanded).replaceAll('\\', '/');
}

/**
 * 按真实路径规范化权限目标；目标尚不存在时解析最近存在祖先，保留其余尾部。
 * 保留同步 realpathSync，以免改变搜索遍历与审批的既有行为。
 */
function canonicalizePermissionPath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  let prefix = normalized.startsWith('/') ? '/' : '';
  let index = 0;
  for (; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.includes('*') || segment.includes('?')) break;
    const candidate = resolve(prefix || '/', segment);
    try { prefix = realpathSync(candidate).replaceAll('\\', '/'); }
    catch { prefix = candidate.replaceAll('\\', '/'); index += 1; break; }
  }
  return resolve(prefix || '/', ...segments.slice(index)).replaceAll('\\', '/');
}

/** 权限规则的 glob 与 minimatch 不同：`**` 跨目录，`*` 与 `?` 不跨目录。 */
function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') { expression += '(?:.*/)?'; index += 2; }
      else { expression += '.*'; index += 1; }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}
