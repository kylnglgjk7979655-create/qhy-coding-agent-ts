import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join } from 'node:path';

const skillsRoot = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
const taskSkills: Record<string, readonly string[]> = {
  implement: ['implement-spec', 'tdd', 'diagnosing-bugs', 'codebase-design', 'pr'],
  'implement-prd': ['implement-spec', 'tdd', 'diagnosing-bugs', 'codebase-design', 'pr'],
  review: ['code-review', 'tdd', 'codebase-design'],
  'implement-pr': ['tdd', 'diagnosing-bugs'],
  'update-branch': ['tdd'],
  'to-issues': ['to-tickets'],
  architecture: ['codebase-design'],
};
export async function loadTaskSkills(mode: string, root = skillsRoot): Promise<string> {
  const names = taskSkills[mode];
  if (!names) throw new Error(`没有配置任务 skill：${mode}`);
  const parts = [];
  for (const name of names) {
    const directory = resolve(root, name);
    const instructions = await readFile(join(directory, 'SKILL.md'), 'utf8');
    const files = (await readdir(directory, { recursive: true })).filter((file) => /\.(md|sh)$/.test(file) && file !== 'SKILL.md');
    const references = files.map((file) => `${relative(root, join(directory, file))}：${join(directory, file)}`).join('\n');
    parts.push(`## 已加载 ${name}\n来源目录：${directory}\n下文相对引用从此目录解析，按引用条件读取。\n${instructions}\n\n引用资源：\n${references || '无'}`);
  }
  return parts.join('\n\n');
}
