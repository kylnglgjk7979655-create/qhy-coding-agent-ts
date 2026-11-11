# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

使用 $implement skill 实现本 Issue。

You are on branch `{{BRANCH}}`, created from `main` or continued from the parent issue’s shared branch.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read the project's domain and architecture docs before changing code:

- `GLOSSARY.md`
- `docs/adr/` if relevant
- `CODING_STANDARDS.md`

Explore the repo and relevant tests before editing.

# EXECUTION

Where a test seam already exists, or a new one is being proposed, do red-green-refactor:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Do not improvise new test seams, such as extracting out a function so that it can be tested in isolation. This creates spaghetti tests.

Before committing, run `pnpm check` and ensure it passes. Fix failures and rerun before declaring completion.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.

Do not push the branch.
Do not close the issue.
Do not edit labels.
Do not create or edit PRs.

# PR 文案

代码实现、完整检查和提交完成后，在当前会话调用仓库的 $pr skill；读取 `.agents/skills/pr/SKILL.md`，按其中模板撰写中文标题和正文。

若有父 PRD，标题和总结围绕整个父需求，并通过 `gh api repos/$GH_REPO/issues/{{PR_ISSUE_NUMBER}}/sub_issues` 核对全部子票。清楚区分本轮已实现、之前已完成与仍待实现的内容；草稿 PR 不代表所有子任务已完成。

Evidence 只引用本会话实际执行的命令及结果；未获得修改前的运行证据时如实注明，不能把未运行、失败或未完成的检查写成通过。本会话只创建提交，当前 Agent 阶段尚未推送；workflow 在认证回存及校验成功后负责推送并创建或更新 Draft PR。描述状态时明确这是阶段时序，不得声称推送已经发生。

普通 implement 后会自动请求整体 CR，CR 成功后由 workflow 接续 Agent QA。当前会话未执行这些后续阶段时，说明它们将由 workflow 接续，不得声称已通过。Merge Danger 依 skill 说明回滚难度和影响范围。

把结果写入 `{{PR_METADATA_PATH}}`（位于仓库之外），JSON 格式为：

```json
{"prTitle":"fix: 简洁的改动标题","prDescription":"按 pr skill 模板生成的完整 Markdown 正文"}
```

标题为单行，最多 70 字符。自动关闭 Issue 的指令由包装脚本绑定 #{{PR_ISSUE_NUMBER}}；文案中只使用普通票号链接。文案文件由 workflow 读取以创建或更新共享 Draft PR。

确认文件已写入后，输出 `<promise>COMPLETE</promise>`。
