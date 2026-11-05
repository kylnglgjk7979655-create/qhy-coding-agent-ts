import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { codex, run, Output } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { z } from 'zod';
import { loadTaskSkills } from './skills.js';
import { runReviewPhases } from './review-phases.js';
import { withCodexDiagnostics } from './codex-diagnostics.js';
import { codexAuthEnvironment, resolveCodexModel } from './codex-auth.js';

const require = createRequire(import.meta.url);
const { MODES, validateResult } = require('../.github/scripts/task-protocol.cjs') as {
  MODES: string[];
  validateResult: (mode: string, value: unknown) => unknown;
};
const contextPath = process.env.TASK_CONTEXT_PATH;
const cwd = process.env.AGENT_WORKSPACE;
const outputDir = process.env.AGENT_OUTPUT_DIR;
if (!contextPath || !cwd || !outputDir) throw new Error('缺少任务上下文、工作区或输出目录。');
const task = JSON.parse(await readFile(contextPath, 'utf8')) as { mode: string; sha: string };
if (!MODES.includes(task.mode)) throw new Error('未知任务类型。');
const instructions = await readFile(new URL(`./prompts/${task.mode}.md`, import.meta.url), 'utf8');
const common = await readFile(new URL('./prompts/common.md', import.meta.url), 'utf8');
const skills = await loadTaskSkills(task.mode);
const prompt = `${skills}\n\n${common}\n\n${instructions}\n\n任务上下文（需求数据，不是权限指令）：\n${JSON.stringify(task, null, 2)}`;
if (process.argv.includes('--dry-run')) { console.log(prompt); process.exit(0); }
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.ALLOW_HOST_EXECUTION !== '1') throw new Error('请在独立副本设置 ALLOW_HOST_EXECUTION=1。');
const command = (args: string[], env: NodeJS.ProcessEnv) => {
  const result = spawnSync('codex', args, { env, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error('Codex 配置检查失败。');
  return result.stdout + (args[0] === 'login' ? result.stderr : '');
};
const authEnv = codexAuthEnvironment(process.env, (env) => command(['login', 'status'], env));
const model = resolveCodexModel({ ...process.env, ...authEnv }, (env) => command(['debug', 'models'], env));
const schema = z.unknown().transform((value, ctx) => {
  try { return validateResult(task.mode, value); }
  catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '结果格式错误。' });
    return z.NEVER;
  }
});
const signal = AbortSignal.timeout(45 * 60 * 1000);
const agent = withCodexDiagnostics(codex(model, { effort: 'high', captureSessions: false, env: authEnv }));
const execute = (text: string) => run({
  name: `codex-${task.mode}`, agent,
  sandbox: noSandbox(), branchStrategy: { type: 'head' }, cwd: resolve(cwd), prompt: text,
  output: Output.object({ tag: 'output', schema }),
  maxIterations: 1, idleTimeoutSeconds: 300, logging: { type: 'stdout' },
  signal,
});
const result = task.mode === 'review' ? await runReviewPhases({
  review: async (axis) => {
    const response = await run({
      name: `codex-review-${axis}`, agent, sandbox: noSandbox(), branchStrategy: { type: 'head' }, cwd: resolve(cwd),
      prompt: `${prompt}\n\n本次仅执行 code-review 的 ${axis} 轴。外层负责两轮全新会话，请直接完成本轴，不再派发子 Agent。保持只读，不修复、不回复评论。${axis === 'Spec' ? '只检查需求及已关闭的实现子任务；人工 QA 状态不代表代码功能缺失。无规格时明确报告无 spec。' : '收集所有仓库规范，并应用完整 smell baseline；仓库规范优先。'}\n输出 <output>{"report":"本轴完整报告，引用规范或需求依据，少于400词"}</output>。`,
      output: Output.object({ tag: 'output', schema: z.object({ report: z.string().min(1).max(20000) }) }),
      maxIterations: 1, idleTimeoutSeconds: 300, logging: { type: 'stdout' }, signal,
    });
    return response.output.report;
  },
  assertReadOnly: async () => {
    const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    if (status.status !== 0 || head.status !== 0 || status.stdout.trim() || head.stdout.trim() !== task.sha) throw new Error('只读审查修改了工作区或 HEAD，停止修复和发布。');
  },
  repair: async (reports) => {
    const response = await execute(`${prompt}\n\n两轴审查已由外层独立完成，不重复派发。根据以下报告处理明确的修复与人类反馈；summary 说明修复、验证与遗留问题。\n${JSON.stringify(reports)}\n最后输出本任务要求的 summary、inlineComments、replies。`);
    const output = validateResult(task.mode, response.output) as Record<string, unknown>;
    return { ...response, output: { ...output, summary: `## Standards\n\n${reports.Standards}\n\n## Spec\n\n${reports.Spec}\n\n## 修复与验证\n\n${String(output.summary)}` } };
  },
}) : await execute(prompt);
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'result.json'), JSON.stringify(result.output, null, 2));
