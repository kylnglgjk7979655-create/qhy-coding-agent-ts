# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

这是 `agent:review` 独立审查阶段。读取 `{{SKILLS_DIRECTORY}}/pr-review/SKILL.md` 并执行其流程。审查用的 skill 从同一固定目录读取；产品代码、运行入口和 `CODING_STANDARDS.md` 从当前 PR 工作目录读取。将 `{{BASE_SHA}}` 作为固定比较基准，将下方 LINKED ISSUE 的完整上下文作为 Spec。父需求的 Spec 包含父 PRD、全部子票和评论。

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

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

1. 在干净的 HEAD 上按 PR Review skill 执行规范、需求、回归、简化判断和运行验证。对照完整需求逐项验收，引用票号指出遗漏、部分实现及越界行为。
2. 在运行验证中操作实际 UI 并保存关键截图（PNG、JPEG 或 WebP），受影响的端到端流程录制从进入到结果的过程（MP4 或 WebM）。将适合分享的证据保存为 `{{EVIDENCE_DIRECTORY}}/<被验证的完整提交 SHA>/` 顶层的可见文件。总结中写实际场景、操作、结果和文件名。适用证据无法取得时，运行验证报告 `BLOCKED` 并说明原因。
3. 若发现可以修复的具体问题，结束只读审查后修复，运行 `pnpm check`，以 conventional commit 提交。之后对新的干净 HEAD 重跑 PR Review，使用新提交的证据。最终结果中的 HEAD 必须是实际完成审查的提交。
4. Respond to unresolved human review threads when useful:
   - Address: change code and reply
   - Decline: do not change code, reply with why
   - Defer: no reply, only for stale/context-only comments

Read `GLOSSARY.md`, relevant ADRs, and `CODING_STANDARDS.md`.

If you make changes, commit them as a single conventional commit.
If the code is already clean and there is nothing to answer, make no commit.

Do not push.
Do not edit labels.
Do not mark review threads resolved.
Do not create GitHub comments yourself.

When complete, output `<promise>COMPLETE</promise>`.
