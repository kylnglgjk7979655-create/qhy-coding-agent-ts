# Issue 分类与执行标签

仓库使用默认五种 triage 标签，与上游 skills 及 Sandcastle 官方领域文档保持同名：

| 标签 | 含义 |
| --- | --- |
| `needs-triage` | 等待维护者判断 |
| `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | 需求明确，适合 Agent 实现；仅表示准备状态 |
| `ready-for-human` | 需要人工判断或实现 |
| `wontfix` | 不处理 |

## 官方 GitHub workflow 标签

| 标签 | 行为 |
| --- | --- |
| `agent:explore` | 批量调查全部开放的 explore Issue；转交明确任务，关闭重复项 |
| `agent:implement` | 独立 Issue 启动实现；PR 启动反馈修改 |
| `agent:review` | PR 审查，可修复代码，发布 COMMENT 并标记 Ready |
| `agent:update-branch` | 同仓库 PR 合并基准分支，处理冲突 |
| `agent:in-progress` | 该轮任务执行中 |
| `agent:blocked` | 运行失败，或 Explore 判断存在外部阻塞 |

`ready-for-agent` 不自动执行。Explore 的 `easy-call` 结论会换成 `agent:implement`，自动接续需要配置 `AGENT_PAT`；`needs-a-human` 换成 `ready-for-human`，`blocked` 换成 `agent:blocked`。结论值本身不是 GitHub 标签。

普通实现不接受父 Issue 或子 Issue。旧的 `agent:to-issues`、`agent:publish-tickets`、`agent:queued`、`source:architecture-review` 不再有 workflow 入口，历史标签保留但不会启动任务。配置和重试见 [GitHub Actions](github-actions.md)。
