import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { codexAgent, fail, gh, required, sh } from "../shared/common.js";

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
    },
  });

  const commitsAhead = Number(sh("git rev-list --count main..HEAD").trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s).`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
