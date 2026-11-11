import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sandcastle from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { codexAgent, fail, outputDir, required, sh } from '../shared/common.js';
import { fetchPullRequestContext } from '../shared/review-context.js';
import { runWithExtraction } from '../shared/run-with-extraction.js';
import { verifyEvidence } from '../qa-only/report.js';
import { qaWorkflowOutputSchema, qaVerdict, renderQaReport, verifyFinalHead } from './report.js';

try {
  const prNumber = required('PR_NUMBER');
  const branch = required('BRANCH');
  const initialHead = sh('git rev-parse HEAD').trim();
  if (sh('git branch --show-current').trim() !== branch) throw new Error('当前分支与 BRANCH 不一致。');
  if (process.env.BRANCH_HEAD_SHA && initialHead !== process.env.BRANCH_HEAD_SHA) {
    throw new Error('检出版本与授权的 PR HEAD 不一致。');
  }
  if (sh('git status --porcelain').trim()) throw new Error('QA 开始前工作树必须干净。');
  const context = fetchPullRequestContext(prNumber);
  const artifacts = path.resolve(outputDir(), 'qa');
  fs.mkdirSync(path.dirname(artifacts), { recursive: true });
  const parent = fs.realpathSync(path.dirname(artifacts));
  const workspace = fs.realpathSync(process.cwd());
  if (parent === workspace || parent.startsWith(`${workspace}${path.sep}`)) {
    throw new Error('QA artifact 目录必须位于产品仓库外。');
  }
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'spec.md'), context.linkedIssue);
  const result = await runWithExtraction({
    name: `qa-pr-${prNumber}`,
    agent: codexAgent(), sandbox: noSandbox(), logging: { type: 'stdout' },
    promptFile: path.join(import.meta.dirname, 'prompt.md'),
    promptArgs: {
      SKILLS_DIRECTORY: path.resolve(import.meta.dirname, '../../../.agents/skills'),
      PR_NUMBER: prNumber, BRANCH: branch, PR_TITLE: context.prTitle,
      SPEC: context.linkedIssue, DIFF_TO_MAIN: context.diff,
      PR_COMMENTS_JSON: context.prCommentsJson, ARTIFACTS_DIRECTORY: artifacts,
      INITIAL_HEAD: initialHead,
    },
    output: sandcastle.Output.object({ tag: 'output', schema: qaWorkflowOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, 'extraction.md'), 'utf8'),
  });
  if (sh('git branch --show-current').trim() !== branch || sh('git status --porcelain').trim()) {
    throw new Error('QA 完成后分支必须保持一致，产品修改必须提交。');
  }
  const finalHead = sh('git rev-parse HEAD').trim();
  sh(`git merge-base --is-ancestor ${initialHead} ${finalHead}`);
  verifyEvidence(result.output, artifacts);
  verifyFinalHead(result.output, initialHead, finalHead);
  const verdict = qaVerdict(result.output);
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({
    ...result.output, initialHead, finalHead, fixedPoint: 'main', verdict,
  }, null, 2));
  fs.writeFileSync(path.join(artifacts, 'report.md'), renderQaReport(result.output, initialHead, finalHead));
  fs.writeFileSync(path.join(artifacts, 'verdict.txt'), verdict);
  console.log(`QA complete: ${verdict}. Report: ${path.join(artifacts, 'report.md')}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
