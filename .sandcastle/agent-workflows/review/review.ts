import * as fs from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  outputDir,
  required,
  sh,
  writeJson,
  writeText,
} from "../shared/common.js";
import { fetchPullRequestContext } from "../shared/review-context.js";
import {
  filterInlineComments,
  filterReplies,
  reviewOutputSchema,
} from "../shared/review-output.js";
import { runWithExtraction } from "../shared/run-with-extraction.js";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

try {
  const context = fetchPullRequestContext(PR_NUMBER);
  const baseSha = sh("git rev-parse --verify main^{commit}").trim();
  const evidenceDirectory = path.resolve(outputDir(), 'review-evidence');

  const result = await runWithExtraction({
    name: `review-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      SKILLS_DIRECTORY: path.resolve(import.meta.dirname, '../../../.claude/skills'),
      BASE_SHA: baseSha,
      EVIDENCE_DIRECTORY: evidenceDirectory,
      PR_NUMBER,
      BRANCH,
      PR_TITLE: context.prTitle,
      ISSUE_NUMBER: context.issueNumber || "(none)",
      ISSUE_TITLE: context.issueTitle || "(no linked issue)",
      LINKED_ISSUE: context.linkedIssue,
      DIFF_TO_MAIN: context.diff,
      PR_COMMENTS_JSON: context.prCommentsJson,
    },
    output: sandcastle.Output.object({
      tag: "output",
      schema: reviewOutputSchema,
    }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const validInlineComments = filterInlineComments(
    result.output.inlineComments,
    context.diffLines,
  );
  const validReplies = filterReplies(
    result.output.replies,
    context.validReplyIds,
  );
  const headSha = sh("git rev-parse HEAD").trim();
  const { checks, reviewedHead, requiredEvidence, summary } = result.output;
  if (reviewedHead !== headSha || sh("git status --porcelain").trim()) {
    throw new Error(`审查结果必须对应干净的当前 HEAD ${headSha}，报告提交为 ${reviewedHead}。`);
  }
  const report = [
    `审查提交：${headSha}`,
    summary,
    checks.map(({ name, status, details }) => `- **${name} · ${status}**：${details}`).join('\n'),
  ].join('\n\n');
  if (checks.some(({ status }) => status === 'FAIL' || status === 'BLOCKED')) {
    throw new Error(report);
  }
  if (requiredEvidence.length > 0) {
    if (checks.find(({ name }) => name === 'verification')?.status !== 'PASS') {
      throw new Error(`适用截图或录屏时，运行验证必须通过。\n\n${report}`);
    }
    const headEvidence = path.join(evidenceDirectory, headSha);
    const files = fs.existsSync(headEvidence)
      ? fs.readdirSync(headEvidence, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && fs.statSync(path.join(headEvidence, entry.name)).size > 0)
        .map((entry) => path.extname(entry.name).toLowerCase())
      : [];
    const extensions = { screenshot: ['.png', '.jpg', '.jpeg', '.webp'], recording: ['.mp4', '.webm'] };
    const missing = requiredEvidence.filter((kind) => !extensions[kind].some((extension) => files.includes(extension)));
    if (missing.length > 0) {
      throw new Error(`运行验证 BLOCKED：${headSha} 缺少 ${missing.join('、')} 证据。\n\n${report}`);
    }
  }

  writeJson("review_payload.json", {
    commit_id: headSha,
    event: "COMMENT",
    body: report,
    comments: validInlineComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });
  writeJson("replies.json", validReplies);
  writeText("review_evidence_required.txt", String(requiredEvidence.length > 0));
  writeText("summary.md", report);
  writeText("verdict.txt", result.commits.length > 0 ? "improved" : "clean");

  console.log("Review complete.");
  console.log(`Commits: ${result.commits.length}.`);
  console.log(`Inline comments: ${validInlineComments.length}.`);
  console.log(`Replies: ${validReplies.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
