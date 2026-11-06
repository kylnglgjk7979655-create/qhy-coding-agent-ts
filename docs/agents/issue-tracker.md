# Issue tracker：GitHub

本仓库的需求、规格和实施工单以 GitHub Issues 为准。本地与 GitHub Actions 使用同一 tracker：`kylnglgjk7979655-create/qhy-coding-agent-ts`。使用 `gh` CLI 操作，仓库地址由 Git remote 核对。

## 需求来源与发布

- Skill 要求“publish to the issue tracker”时，创建或更新 GitHub Issue，并返回实际 Issue URL；`to-spec` 发布后添加 `ready-for-agent`。
- Skill 要求“fetch the relevant ticket”时，读取 Issue 正文、评论、标签及相关原生父子与阻塞关系；更新已有需求前先读取当前内容。
- `.scratch/` 用于访谈、草稿、历史记录、测试夹具和临时材料；本地文件不代表已向 tracker 发布，也不能取代关联 Issue 的最新正文与评论。
- 只有用户明确要求迁移的本地规格才发布到 GitHub；既有本地历史不自动批量迁移。发布前查询现有 Issue，避免重复创建。
- GitHub Actions 入口以 workflow 下载的 Issue JSON 为本轮需求，并读取关联评论和关系；`.scratch/` 仅作补充。配置与故障处理见 [github-actions.md](github-actions.md)。

## 常用操作

以下命令在仓库内执行；跨目录运行时显式指定 `--repo kylnglgjk7979655-create/qhy-coding-agent-ts`。多行正文先写入 UTF-8 文件，通过 `--body-file` 传入。

- 创建：`gh issue create --title "标题" --body-file <正文文件> --label ready-for-agent`。
- 读取：`gh issue view <编号> --json number,title,body,labels,comments,url,state`。
- 列出：`gh issue list --state open --json number,title,labels,url`，按需增加标签或状态筛选。
- 更新：`gh issue edit <编号> --body-file <正文文件>`。
- 评论：`gh issue comment <编号> --body-file <评论文件>`。
- 标签：`gh issue edit <编号> --add-label <标签>` 或 `--remove-label <标签>`。
- 关闭：在任务约定允许关闭时使用 `gh issue close <编号>`；人工 QA 及父规格关闭规则见 [skill-execution.md](skill-execution.md)。

`ready-for-agent` 只表示需求准备完成；用户明确要求实现时才添加 `agent:implement` 或手动运行。标签词汇见 [triage-labels.md](triage-labels.md)。无法访问 GitHub 时说明失败原因，不将本地草稿报告为已发布。

## 父子任务与依赖

使用 GitHub 原生子 Issue 与阻塞关系，正文中的任务列表或“依赖 #N”仅为说明，不能取代调度依据。

- 建立父子关系：`gh issue create --parent <父编号> ...`；已有子 Issue 也可通过 GitHub sub-issues API 挂接。
- 读取子 Issue：`gh api repos/kylnglgjk7979655-create/qhy-coding-agent-ts/issues/<父编号>/sub_issues`。
- 添加阻塞关系：`gh api --method POST repos/kylnglgjk7979655-create/qhy-coding-agent-ts/issues/<子编号>/dependencies/blocked_by -F issue_id=<阻塞项数据库ID>`。
- 数据库 ID 通过 `gh api repos/kylnglgjk7979655-create/qhy-coding-agent-ts/issues/<编号> --jq .id` 获取，不使用显示编号或 node ID 替代。
- 本仓库云端规划、发布、实施与关闭职责按 [skill-execution.md](skill-execution.md) 执行。

## Pull requests as a triage surface

**PRs as a request surface: no.**

PR 仍可进入已有代码审查或反馈修改流程；Issue 是需求入口。GitHub 的 Issue 与 PR 共用编号，读取前应区分对象类型。

## Wayfinding

- Map 使用单个标记 `wayfinder:map` 的 Issue，包含 Notes、Decisions-so-far 与 Fog。
- Child ticket 使用原生子 Issue 和 `wayfinder:<type>` 标签；领取时指派给执行者。
- Frontier 查询开放、未指派且无开放阻塞项的子 Issue，按 map 顺序选择。
- Resolve 时把答案写入评论、关闭已解决工单，再更新 map 的决策摘要及链接。
- 新增此流程所需的标签时先查询已有标签，避免重复创建。
