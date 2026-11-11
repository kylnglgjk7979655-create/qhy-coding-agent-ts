import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sandcastle from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { codexAgent, fail, outputDir, required } from '../shared/common.js';
import { fetchPullRequestContext } from '../shared/review-context.js';
import { runWithExtraction } from '../shared/run-with-extraction.js';
import { readOnlySnapshot } from './read-only.js';
import { qaOutputSchema, qaVerdict, renderQaReport, verifyEvidence } from './report.js';

const prNumber = required('PR_NUMBER');
const branch = required('BRANCH');

try {
  const before = readOnlySnapshot();
  if (process.env.BRANCH_HEAD_SHA && before.head !== process.env.BRANCH_HEAD_SHA) {
    throw new Error('检出版本与授权的 PR HEAD 不一致。');
  }
  const context = fetchPullRequestContext(prNumber);
  const fixedPoint = 'main';
  const artifacts = path.resolve(outputDir(), 'qa-only');
  const workspace = fs.realpathSync(process.cwd());
  if (artifacts === workspace || artifacts.startsWith(`${workspace}${path.sep}`)) {
    throw new Error('QA artifact 目录必须位于产品仓库外。');
  }
  fs.mkdirSync(path.dirname(artifacts), { recursive: true });
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'spec.md'), context.linkedIssue);

  const result = await runWithExtraction({
    name: `qa-only-pr-${prNumber}`,
    agent: codexAgent(), sandbox: noSandbox(), logging: { type: 'stdout' },
    promptFile: path.join(import.meta.dirname, 'prompt.md'),
    promptArgs: {
      SKILLS_DIRECTORY: path.resolve(import.meta.dirname, '../../../.agents/skills'),
      PR_NUMBER: prNumber, BRANCH: branch, PR_TITLE: context.prTitle,
      SPEC: context.linkedIssue, PR_BODY: context.prBody,
      DIFF_TO_MAIN: context.diff, PR_COMMENTS_JSON: context.prCommentsJson,
      TESTED_HEAD: before.head, FIXED_POINT: fixedPoint, ARTIFACTS_DIRECTORY: artifacts,
    },
    output: sandcastle.Output.object({ tag: 'output', schema: qaOutputSchema }),
    extractionPrompt: fs.readFileSync(path.join(import.meta.dirname, 'extraction.md'), 'utf8'),
  });

  if (readOnlySnapshot().fingerprint !== before.fingerprint) {
    throw new Error('qa-only 修改了产品文件或提交；拒绝发布有效验收结论。请核查运行记录。');
  }
  verifyEvidence(result.output, artifacts);
  const verdict = qaVerdict(result.output);
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({
    testedHead: before.head, fixedPoint, workingTree: before.workingTree, verdict, ...result.output,
  }, null, 2));
  fs.writeFileSync(path.join(artifacts, 'report.md'), renderQaReport(result.output, before, fixedPoint));
  fs.writeFileSync(path.join(artifacts, 'verdict.txt'), verdict);
  console.log(`QA Only complete: ${verdict}. Report: ${path.join(artifacts, 'report.md')}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
