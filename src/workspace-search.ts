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

async function workspaceFiles(workspace: string, requestedPath?: string): Promise<{ root: string; paths: string[] }> {
  const root = await searchRoot(workspace, requestedPath);
  const files: string[] = [];
  const rootRules = await ancestorIgnoreRules(workspace, root);
  if (isIgnored(root, rootRules)) return { root, paths: files };

  async function visit(directory: string, inheritedRules: IgnoreRules[]): Promise<void> {
    const localRules = await gitignoreRules(workspace, directory);
    const rules = localRules ? [...inheritedRules, localRules] : inheritedRules;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const candidate = resolve(directory, entry.name);
      if (isIgnored(candidate, rules)) continue;
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
  return {
    root,
    paths: files.map((file) => toPosix(relative(workspace, file))).sort((left, right) => left.localeCompare(right)),
  };
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

export async function globWorkspace(workspace: string, input: SearchOptions): Promise<{ paths: string[]; truncated: boolean }> {
  const { root, paths: candidates } = await workspaceFiles(workspace, input.path);
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
  return { paths, truncated };
}

export async function grepWorkspace(
  workspace: string,
  input: SearchOptions & { glob?: string | undefined },
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  const expression = new RegExp(input.pattern);
  const { root, paths: candidates } = await workspaceFiles(workspace, input.path);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;

  for (const path of candidates) {
    if (input.glob && !matchesGlob(pathFromSearchRoot(workspace, root, path), input.glob)) continue;
    let content: string;
    try {
      const canonical = await realpath(resolve(workspace, path));
      if (!isWithinWorkspace(workspace, canonical)) continue;
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
  return { matches, truncated };
}

export async function validateSearchRoot(workspace: string, path?: string): Promise<void> {
  await searchRoot(workspace, path);
}
