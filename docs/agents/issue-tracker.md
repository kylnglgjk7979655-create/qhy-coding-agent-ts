# Issue tracker：GitHub Issues

本仓库使用 GitHub Issues 跟踪需求和实现任务。手动调用 skill 和 GitHub Actions 均以对应 GitHub Issue 的正文、评论及标签为需求和状态来源；使用当前仓库的 GitHub remote 确定仓库。用户明确指定其他来源时，遵循用户的要求。

## 操作约定

- 查询待办或指定工单时，通过 `gh issue list`、`gh issue view <编号> --comments` 或等效 GitHub 工具读取。需要判断历史和状态时，同时检查标签、作者、时间和评论。
- skill 要求发布需求、评论或更新状态时，在 GitHub 对应 Issue 执行；triage 状态使用 [triage-labels.md](triage-labels.md) 中的标签。
- 父需求的规格放在 Issue 正文，补充要求放在评论。云端 `agent:to-issues` 校验需求后自动创建子 Issue 和原生依赖；实现仍需给父 Issue 添加 `agent:implement`；完整流程见 [GitHub Actions 与 Agent 认证](github-actions.md)。
- `.scratch/` 用于临时工作文件、历史资料和明确指定的本地背景；其中的文件不代表 GitHub Issue 的当前状态。

## Wayfinding 工作文件

`/wayfinder` 的本地工作记录可继续放在 `.scratch/<effort>/`：`map.md` 保存地图，`issues/NN-<slug>.md` 保存子问题、类型、状态、依赖和答案。这些文件是工作记录；需要发布到 issue tracker 的结果按上述约定写入 GitHub。

- 子问题的 `Type:` 为 `research`、`prototype`、`grilling` 或 `task`；`Status:` 为 `claimed` 或 `resolved`。
- `Blocked by: NN, NN` 记录依赖；所有依赖均为 `resolved` 时才可领取。扫描开放、未阻塞且未领取的子问题，优先选择编号最小者。
- 领取时先保存 `Status: claimed`；完成时在 `## Answer` 下追加答案，改为 `Status: resolved`，并在地图的 Decisions-so-far 中追加摘要和链接。
