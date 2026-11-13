# Issue 分类与执行标签

## 分诊标签

| 标签 | 含义 |
| --- | --- |
| `needs-triage` | 等待维护者判断 |
| `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | 需求明确，适合 Agent；仅表示准备状态 |
| `ready-for-human` | 需要人工判断或实现 |
| `wontfix` | 不处理 |

## 工作流标签

| 标签 | 作用 |
| --- | --- |
| `agent:to-issues` | 父 Issue：拆分后自动创建子 Issue 和原生依赖 |
| `agent:implement` | Issue：开始或恢复实现；PR：处理已有反馈 |
| `agent:implement-spec` | 父 Issue：对已有子任务按 `implement-spec` 并行实现并交付集成 PR，不拆票 |
| `agent:queued` | Issue／父 Issue：保留实现授权，等待依赖或下一张子票 |
| `agent:review` | PR：整体审查、允许修复并发布 COMMENT，完成后标记 Ready |
| `agent:update-branch` | 同仓库 PR：合并基准分支并处理冲突 |
| `agent:explore` | 批量调查开放的 explore Issue，识别重复并转交 |
| `agent:in-progress` | 当前任务执行中 |
| `agent:blocked` | 运行失败、人工暂停或存在外部阻塞，等待处理 |

`agent:publish-tickets` 已停用；`agent:to-issues` 直接完成创建，不再审核计划。已有旧计划需要重新添加 `agent:to-issues`；若已有子票，先核对并清理旧关系，避免重复拆分。

父需求子票提交到共享 Draft PR 后自动接续，全部完成后整体审查。PR 合并到 main 后自动关闭父 Issue。暂停父需求可添加 `agent:blocked`；已运行的 Actions 需另行取消，恢复时重新添加 `agent:implement`。

Explore 的 verdict 是输出字段，不是标签：easy-call 转交 implement，needs-a-human 转 ready-for-human，blocked 转 agent:blocked；重复 Issue 被评论并关闭。

标签触发、`AGENT_PAT` 配置和失败恢复见 [GitHub Actions](github-actions.md)。正文的依赖文字不代替原生依赖，关闭前置必须为 completed。QA 入口（`agent:qa`、`agent:qa-only`）暂未接入 workflow，`qa-only` skill 保留供本地验证。
