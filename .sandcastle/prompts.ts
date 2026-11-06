import { readFile } from 'node:fs/promises';

const parts: Record<string, readonly string[]> = {
  implement: ['method-tdd', 'verification'],
  bugfix: ['method-diagnosis', 'method-tdd', 'verification'],
  'code-design': ['method-design'],
  review: ['method-tdd', 'verification'],
  'implement-pr': ['method-diagnosis', 'method-tdd', 'verification'],
  'update-branch': ['verification'],
  'to-issues': [],
  architecture: ['method-design'],
};

/** 只从控制脚本版本读取已适配的完整模板，运行时不读取 skill。 */
export async function loadTaskPrompt(mode: string, root = new URL('./prompts/', import.meta.url)): Promise<string> {
  const methods = parts[mode];
  if (!methods) throw new Error(`没有配置任务模板：${mode}`);
  const files = ['common', mode, ...methods];
  return (await Promise.all(files.map((name) => readFile(new URL(`${name}.md`, root), 'utf8')))).join('\n\n');
}
