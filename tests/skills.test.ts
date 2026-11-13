import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
const walk = async (root: string, current = root): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, full));
    else files.push(relative(root, full));
  }
  return files;
};
const skillsSource = fileURLToPath(new URL('../.agents/skills', import.meta.url));
const skillsCopy = fileURLToPath(new URL('../.claude/skills', import.meta.url));
const skillDirectories = async (): Promise<Set<string>> => new Set(
  (await readdir(skillsSource, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
);

describe('仓库固定的 skill 原文', () => {
  it('全部文件与清单固定的校验值一致，避免不知情地修改内容', async () => {
    const manifest = JSON.parse(await readFile(join(skillsSource, 'UPSTREAM.json'), 'utf8')) as { sha256: Record<string, string> };
    for (const [path, hash] of Object.entries(manifest.sha256)) {
      const content = await readFile(join(skillsSource, path));
      expect(digest(content), path).toBe(hash);
    }
  });

  it('Claude 的 skill 副本与固定原文逐文件一致', async () => {
    const skills = await skillDirectories();
    const files = (await walk(skillsSource)).filter((path) => skills.has(path.split('/')[0]!));
    for (const path of files) {
      const original = await readFile(join(skillsSource, path));
      const duplicated = await readFile(join(skillsCopy, path));
      expect(digest(duplicated), path).toBe(digest(original));
    }
    expect((await readdir(skillsCopy)).sort()).toEqual([...skills].sort());
  });

  it('CLAUDE.md 与 AGENTS.md 内容一致', async () => {
    const agents = await readFile(fileURLToPath(new URL('../AGENTS.md', import.meta.url)));
    const claude = await readFile(fileURLToPath(new URL('../CLAUDE.md', import.meta.url)));
    expect(digest(claude)).toBe(digest(agents));
  });
});