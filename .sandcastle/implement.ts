import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { codex, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { createIssuePrompt } from './issue-context.js';
import { codexAuthEnvironment } from './codex-auth.js';

const contextPath = process.env.ISSUE_CONTEXT_PATH;
if (!contextPath) throw new Error('缺少 ISSUE_CONTEXT_PATH；请指定 Issue JSON 文件。');
const instructions = await readFile(new URL('./implement.prompt.md', import.meta.url), 'utf8');
const prompt = createIssuePrompt(JSON.parse(await readFile(contextPath, 'utf8')), instructions);
if (process.argv.includes('--dry-run')) {
  console.log(prompt);
  process.exit(0);
}
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.ALLOW_HOST_EXECUTION !== '1') {
  throw new Error('本地执行会直接修改当前目录；请在独立副本设置 ALLOW_HOST_EXECUTION=1。');
}

const authEnv = codexAuthEnvironment(process.env, (env) => {
  const result = spawnSync('codex', ['login', 'status'], {
    env, encoding: 'utf8', timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error('Codex login status failed');
  return result.stdout + result.stderr;
});
const outputDir = resolve(process.env.AGENT_OUTPUT_DIR ?? '.sandcastle/output');
await mkdir(outputDir, { recursive: true });

const result = await run({
  name: 'codex-implement-issue',
  agent: codex(process.env.CODEX_MODEL || 'gpt-5.4', {
    effort: 'high',
    captureSessions: false,
    env: authEnv,
  }),
  sandbox: noSandbox(),
  branchStrategy: { type: 'head' },
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  prompt,
  maxIterations: 1,
  idleTimeoutSeconds: 300,
  logging: { type: 'stdout' },
  signal: AbortSignal.timeout(45 * 60 * 1000),
});

await writeFile(resolve(outputDir, 'summary.md'), result.stdout || 'Codex 已完成本轮任务。\n');
