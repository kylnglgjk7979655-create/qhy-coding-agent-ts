# TASK

Address unresolved review feedback on PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

反馈需要修改代码时，使用 $implement skill。

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

This is not a fresh review. Focus on the PR conversation and unresolved feedback.

# LINKED ISSUE

{{LINKED_ISSUE}}

# CURRENT DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# PROCESS

For each actionable comment or unresolved thread:

- Change code when the reviewer is right.
- Reply when a reply adds useful context.
- Decline clearly when the requested change is wrong or out of scope.
- Ignore stale/context-only comments.

Before committing, run `pnpm check` and ensure it passes. Fix failures and rerun before declaring completion.

If you change code, commit with a conventional commit message.

若本轮无需新增提交（反馈已由现有提交解决，或已无待处理反馈），在完成前写出一段可发布到 PR 的说明，供后续提取到 `topLevelComments`：说明无需修改的原因、对应的已有提交（如有），以及本轮实际执行的验证及结果；未执行验证时如实注明。

Do not push.
Do not edit labels.
Do not resolve review threads.
Do not create GitHub comments yourself.

本 Agent 阶段只在分支上创建提交；后续 workflow 负责推送并发布提交或回复。运行总结须区分当前阶段与完整 workflow 状态：未观察到发布结果时，不得声称已推送或已发布，也不要把当前阶段尚未推送说成完整流程的最终状态。

When complete, output `<promise>COMPLETE</promise>`.
