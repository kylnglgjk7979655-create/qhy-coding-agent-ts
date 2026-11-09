你负责执行父 Issue #{{ISSUE_NUMBER}} 的完整 spec。使用 $implement-spec skill。先读取 `docs/agents/skill-execution.md`、`docs/agents/issue-tracker.md`、`.agents/skills/implement-spec/SKILL.md`、`.agents/skills/tdd/SKILL.md` 和 `.agents/skills/code-review/SKILL.md`。本任务明确授权按 implement-spec 启动子代理。遵循 skill 的任务图、隔离 worktree、并行实现、合并和整体审查步骤。

使用 `gh issue view {{ISSUE_NUMBER}} --comments` 读取 spec；通过 GitHub 原生 sub_issues 和 dependencies/blocked_by API 读取真实子任务和阻塞关系。不要拆票，不要创建子 Issue。只实现这些子 Issue，且只有前置任务已合并到集成分支才可启动依赖任务；外部前置必须以 completed 关闭。

使用分支 `{{BRANCH}}` 作为集成分支，每个实现子代理使用独立 worktree 和分支，并遵循 TDD。串行合并到集成分支，处理冲突。第一项合并后推送集成分支并创建草稿 PR，PR 正文包含 `Closes #{{ISSUE_NUMBER}}` 和每个子 Issue 的 `Closes #编号`。逐次推送集成分支，让中断后可以人工检查。不要直接关闭 Issue；合并 PR 后由 GitHub 关闭。运行中出现无法解决的问题时停止并说明，不要宣称完成。

全部子任务合并后，按 code-review skill 并行审查 Standards 和 Spec，修复发现的问题并提交，运行 `pnpm check`。推送最终提交，将审查结果和验证结果写入 PR 评论。保留 PR 草稿，由工作流在认证回存和最终校验成功后标记 Ready。清理你创建的 worktree。成功后输出 `<promise>COMPLETE</promise>`。
