import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import { isWithinWorkspace } from './workspace-files.js';

const MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 32_000;

interface IgnoreRules {
  base: string;
  matcher: ReturnType<typeof ignore>;
}

interface SearchOptions {
  path?: string | undefined;
  pattern: string;
}

export type SearchPermissionAction = 'allow' | 'ask' | 'deny' | undefined;
export type SearchPermission = (absolutePath: string) => SearchPermissionAction;

export interface SearchPermissionScope {
  asks: string[];
  excluded: string[];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

async function searchRoot(workspace: string, requestedPath?: string): Promise<string> {
  const candidate = resolve(workspace, requestedPath ?? '.');
  const target = await realpath(candidate);
  if (!isWithinWorkspace(workspace, target) || !(await stat(target)).isDirectory()) {
    throw new Error('搜索目录必须是工作区内的目录。');
  }
  return target;
}

async function gitignoreRules(workspace: string, directory: string): Promise<IgnoreRules | undefined> {
  try {
    const ignoreFile = await realpath(resolve(directory, '.gitignore'));
    if (!isWithinWorkspace(workspace, ignoreFile)) return undefined;
    const content = await readFile(ignoreFile, 'utf8');
    return { base: directory, matcher: ignore().add(content) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ancestorIgnoreRules(workspace: string, root: string): Promise<IgnoreRules[]> {
  const rules: IgnoreRules[] = [];
  let directory = workspace;
  const relativeRoot = relative(workspace, root);
  for (const segment of relativeRoot === '' ? [] : relativeRoot.split(sep).slice(0, -1)) {
    directory = resolve(directory, segment);
    const rule = await gitignoreRules(workspace, directory);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isIgnored(path: string, rules: IgnoreRules[]): boolean {
  let ignored = false;
  for (const { base, matcher } of rules) {
    const relativePath = toPosix(relative(base, path));
    if (relativePath === '') continue;
    const result = matcher.test(relativePath);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function workspaceFiles(
  workspace: string,
  requestedPath?: string,
  permission?: SearchPermission,
  approvedAsks?: string[],
): Promise<{ root: string; paths: string[]; excluded: string[]; asks: string[] }> {
  const root = await searchRoot(workspace, requestedPath);
  const files: string[] = [];
  const excluded: string[] = [];
  const asks: string[] = [];
  if (permission?.(root) === 'deny') throw new Error('搜索根目录被权限规则禁止。');
  if (permission?.(root) === 'ask') asks.push(toPosix(relative(workspace, root)) || '.');
  const rootRules = await ancestorIgnoreRules(workspace, root);
  if (isIgnored(root, rootRules)) return { root, paths: files, excluded, asks };

  async function visit(directory: string, inheritedRules: IgnoreRules[]): Promise<void> {
    const localRules = await gitignoreRules(workspace, directory);
    const rules = localRules ? [...inheritedRules, localRules] : inheritedRules;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const candidate = resolve(directory, entry.name);
      if (isIgnored(candidate, rules)) continue;
      const action = permission?.(candidate);
      if (action === 'deny') {
        excluded.push(toPosix(relative(workspace, candidate)));
        continue;
      }
      if (action === 'ask') asks.push(toPosix(relative(workspace, candidate)));
      if (entry.isDirectory()) {
        await visit(candidate, rules);
        continue;
      }

      // 目录符号链接不递归，避免循环；文件链接只在工作区边界内读取。
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        if (entry.isSymbolicLink() && (await lstat(candidate)).isSymbolicLink()) {
          const linkTarget = await realpath(candidate);
          if (!isWithinWorkspace(workspace, linkTarget) || !(await stat(linkTarget)).isFile()) continue;
          const targetAction = permission?.(linkTarget);
          if (targetAction === 'deny') {
            excluded.push(toPosix(relative(workspace, candidate)));
            continue;
          }
          if (targetAction === 'ask') asks.push(toPosix(relative(workspace, linkTarget)));
          files.push(candidate);
          continue;
        }
        const canonical = await realpath(candidate);
        if (!isWithinWorkspace(workspace, canonical) || !(await stat(canonical)).isFile()) continue;
        files.push(candidate);
      } catch {
        // 搜索遇到不可访问或已失效的文件时继续处理其余工作区内容。
      }
    }
  }

  await visit(root, rootRules);
  const compactAsks = compactSearchAsks(asks);
  if (approvedAsks !== undefined && compactAsks.some((path) => !isSearchScopeCovered(path, approvedAsks))) {
    throw new Error('搜索范围在审批后发生变化，需重新提交调用。');
  }
  return {
    root,
    paths: files.map((file) => toPosix(relative(workspace, file))).sort((left, right) => left.localeCompare(right)),
    excluded: excluded.sort((left, right) => left.localeCompare(right)),
    asks: compactAsks,
  };
}

function compactSearchAsks(asks: string[]): string[] {
  const unique = [...new Set(asks)].sort((left, right) => left.localeCompare(right));
  return unique.filter((path) => !unique.some((parent) => parent !== path
    && (parent === '.' || path.startsWith(`${parent}/`))));
}

function isSearchScopeCovered(path: string, approvedAsks: string[]): boolean {
  return approvedAsks.some((approved) => approved === '.' || path === approved || path.startsWith(`${approved}/`));
}

export async function inspectWorkspaceSearch(
  workspace: string,
  requestedPath: string | undefined,
  permission: SearchPermission,
): Promise<SearchPermissionScope> {
  const { asks, excluded } = await workspaceFiles(workspace, requestedPath, permission);
  return { asks, excluded };
}

function matchesGlob(path: string, pattern: string): boolean {
  return minimatch(path, pattern, { dot: true, matchBase: false });
}

function pathFromSearchRoot(workspace: string, root: string, path: string): string {
  return toPosix(relative(root, resolve(workspace, path)));
}

function outputFits(value: unknown): boolean {
  return JSON.stringify(value).length <= MAX_OUTPUT_CHARS;
}

export async function globWorkspace(
  workspace: string,
  input: SearchOptions,
  permission?: SearchPermission,
  approvedAsks?: string[],
): Promise<{ paths: string[]; truncated: boolean; permission_excluded?: string[] }> {
  const { root, paths: candidates, excluded } = await workspaceFiles(workspace, input.path, permission, approvedAsks);
  const paths: string[] = [];
  let truncated = false;
  for (const path of candidates) {
    if (!matchesGlob(pathFromSearchRoot(workspace, root, path), input.pattern)) continue;
    const next = [...paths, path];
    if (next.length > MAX_RESULTS || !outputFits({ paths: next, truncated: false })) {
      truncated = true;
      break;
    }
    paths.push(path);
  }
  return { paths, truncated, ...(excluded.length ? { permission_excluded: excluded } : {}) };
}

export async function grepWorkspace(
  workspace: string,
  input: SearchOptions & { glob?: string | undefined },
  permission?: SearchPermission,
  approvedAsks?: string[],
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; permission_excluded?: string[] }> {
  const expression = new RegExp(input.pattern);
  const { root, paths: candidates, excluded } = await workspaceFiles(workspace, input.path, permission, approvedAsks);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;

  for (const path of candidates) {
    if (input.glob && !matchesGlob(pathFromSearchRoot(workspace, root, path), input.glob)) continue;
    let canonical: string;
    let content: string;
    try {
      canonical = await realpath(resolve(workspace, path));
    } catch {
      continue;
    }
    if (!isWithinWorkspace(workspace, canonical)) continue;
    const action = permission?.(canonical);
    if (action === 'deny') {
      excluded.push(toPosix(relative(workspace, path)));
      continue;
    }
    if (action === 'ask' && !isSearchScopeCovered(toPosix(relative(workspace, canonical)), approvedAsks ?? [])) {
      throw new Error('搜索范围在审批后发生变化，需重新提交调用。');
    }
    try {
      content = await readFile(canonical, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      expression.lastIndex = 0;
      if (!expression.test(text)) continue;
      const next = [...matches, { path, line: index + 1, text }];
      if (next.length > MAX_RESULTS || !outputFits({ matches: next, truncated: false })) {
        truncated = true;
        break;
      }
      matches.push({ path, line: index + 1, text });
    }
    if (truncated) break;
  }
  return { matches, truncated, ...(excluded.length ? { permission_excluded: excluded } : {}) };
}

export async function validateSearchRoot(workspace: string, path?: string): Promise<string> {
  return searchRoot(workspace, path);
}
