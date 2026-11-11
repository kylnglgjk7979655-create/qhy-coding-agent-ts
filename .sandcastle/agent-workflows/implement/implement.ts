import { rmSync } from "node:fs";
import { publishPrMetadata } from "../shared/pr-metadata.js";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { codexAgent, fail, gh, outputDir, required, sh } from "../shared/common.js";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");

try {
  let issueContext = gh(['issue', 'view', ISSUE_NUMBER, '--comments']);
  const parent = process.env.PARENT_NUMBER;
  if (parent) {
    if (!/^[1-9][0-9]*$/u.test(parent)) throw new Error('Invalid parent issue number');
    issueContext += `\n\n# PARENT ISSUE #${parent} (context and constraints; implement only the current child ticket)\n\n${gh(['issue', 'view', parent, '--comments'])}`;
  }

  const prMetadataPath = path.join(outputDir(), "pr-metadata.json");
  rmSync(prMetadataPath, { force: true });
  const result = await sandcastle.run({
    name: `implement-#${ISSUE_NUMBER}`,
    agent: codexAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      BRANCH,
      ISSUE_CONTEXT: issueContext,
      PR_METADATA_PATH: prMetadataPath,
      PR_ISSUE_NUMBER: parent || ISSUE_NUMBER,
    },
  });

  let contextWindow: (typeof result.iterations)[number]["contextWindow"];
  let contextWindowIteration = -1;
  for (let i = result.iterations.length - 1; i >= 0; i--) {
    const candidate = result.iterations[i]?.contextWindow;
    if (candidate && Number.isFinite(candidate.tokens) && candidate.tokens > 0) {
      contextWindow = candidate;
      contextWindowIteration = i + 1;
      break;
    }
  }
  if (contextWindow) {
    const limit = contextWindow.limit;
    const validLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
    const usage = validLimit
      ? `${contextWindow.tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${((contextWindow.tokens / limit) * 100).toFixed(1)}%)`
      : `${contextWindow.tokens.toLocaleString()} tokens`;
    console.log(`Codex 上下文用量（第 ${contextWindowIteration}/${result.iterations.length} 次迭代的最后一次模型请求）：${usage}`);
  } else {
    console.log("Codex 上下文用量：上游未提供上下文窗口数据。");
  }

  const commitsAhead = Number(sh("git rev-list --count main..HEAD").trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  publishPrMetadata(prMetadataPath, Number(parent || ISSUE_NUMBER));

  console.log(`Implementation produced ${commitsAhead} commit(s).`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
