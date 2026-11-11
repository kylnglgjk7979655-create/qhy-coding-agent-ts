# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

使用 $code-review skill 审查本 PR，读取 `{{SKILLS_DIRECTORY}}/code-review/SKILL.md`；相对引用按该 skill 所在目录解析。产品代码和项目规范以当前 PR 工作目录为准。向 skill 明确传入固定比较基准 `main`、下方 LINKED ISSUE 的完整需求上下文作为 Spec，以及根目录 `CODING_STANDARDS.md` 作为规范来源。父需求的 Spec 包含父 PRD 和全部子票，不以某一张子票替代整体需求。

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

You are an expert code reviewer. Your job is not just to comment. Actively improve the branch when a concrete improvement is warranted, then explain what you changed.

# LINKED ISSUE

{{LINKED_ISSUE}}

# DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# REVIEW PROCESS

1. Read the diff carefully.
2. 对照父 PRD 的整体目标、范围和全部子票逐项验收，引用票号指出遗漏、部分实现及越界行为。独立 Issue 按其验收标准审查。
3. Stress-test edge cases and add tests where useful.
4. Improve clarity, maintainability, and consistency while preserving behavior.
5. Respond to unresolved human review threads when useful:
   - Address: change code and reply
   - Decline: do not change code, reply with why
   - Defer: no reply, only for stale/context-only comments

Read `GLOSSARY.md`, relevant ADRs, and `CODING_STANDARDS.md`.

Before committing, run `pnpm check` and ensure it passes. Fix failures and rerun before declaring completion.

If you make changes, commit them as a single conventional commit.
If the code is already clean and there is nothing to answer, make no commit.

Do not push.
Do not edit labels.
Do not mark review threads resolved.
Do not create GitHub comments yourself.

When complete, output `<promise>COMPLETE</promise>`.
