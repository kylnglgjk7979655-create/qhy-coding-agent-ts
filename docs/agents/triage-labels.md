# Issue 分类与执行标签

仓库使用默认五种 triage 标签，与上游 skills 及 Sandcastle 官方领域文档保持同名：

| 标签 | 含义 |
| --- | --- |
| `needs-triage` | 等待维护者判断 |
| `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | 需求明确，适合 Agent 实现；仅表示准备状态 |
| `ready-for-human` | 需要人工判断或实现 |
| `wontfix` | 不处理 |

## GitHub workflow 标签

| 标签 | 作用对象与行为 |
| --- | --- |
| `agent:explore` | 批量调查全部开放的 explore Issue；转交明确任务，关闭重复项 |
| `agent:to-issues` | 父 Issue：从 GitHub spec 生成待审批的拆票计划评论，不创建子任务 |
| `agent:publish-tickets` | 父 Issue：人工批准已生成的计划，创建原生子 Issue 和阻塞依赖，不启动实现 |
| `agent:implement` | 父 Issue：授权逐票执行；独立／子 Issue：依赖满足后启动实现；PR：处理反馈 |
| `agent:queued` | Issue／父 Issue：授权在前置依赖完成、没有冲突的活动任务后启动；定时扫描补偿接续 |
| `agent:review` | PR 审查，可修复代码，发布 COMMENT 并标记 Ready |
| `agent:update-branch` | 同仓库 PR 合并基准分支，处理冲突 |
| `agent:in-progress` | 该轮任务执行中 |
| `agent:blocked` | 运行失败、人工暂停，或 Explore 判断存在外部阻塞；队列不会自动重试 |

`ready-for-agent` 不自动执行。Explore 的 `easy-call` 结论会换成 `agent:implement`，有 `AGENT_PAT` 时立即通过标签事件接续，没有时由定时扫描拾取；`needs-a-human` 换成 `ready-for-human`，`blocked` 换成 `agent:blocked`。结论值本身不是 GitHub 标签。

拆票、审批发布和依赖队列是参考 course-video-manager 增加的项目适配。父需求保留 `agent:queued` 以便在子任务 PR 合并后推进；每个父需求最多有一个活动子任务或未合并 PR，全部完成后仍由维护者验收父需求。正文中的依赖文字不代替 GitHub 原生阻塞关系。

自动接续默认使用内置 `GITHUB_TOKEN` 的内部 dispatch，也兼容可选 `AGENT_PAT` 的标签事件；`agent:queued` 是执行授权，不是纯展示标签。暂停父需求时添加 `agent:blocked`，恢复时重新添加 `agent:implement`；正在执行的 Actions 需要另行取消。`source:architecture-review` 仍没有入口。配置和重试见 [GitHub Actions](github-actions.md)。
