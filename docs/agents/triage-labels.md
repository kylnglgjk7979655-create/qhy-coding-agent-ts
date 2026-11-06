# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role, use the corresponding label string from this table.

## GitHub 自动实现

`ready-for-agent` 仅表示需求准备完成，本地和 GitHub 都不会因此自动启动。给 Issue 或父规格添加任务执行标签，或手动运行才开始；`ready-for-human` / Human QA 始终由人执行。

| 标签 | 含义 |
| --- | --- |
| `agent:implement` | 实现当前 Issue；父规格则授权其 Agent 子任务进入依赖队列 |
| `agent:bugfix` | 复现、诊断、回归测试并修复缺陷 |
| `agent:code-design` | 只读分析并将设计方案发布到 Issue 评论 |
| `agent:review` | 独立审查当前 PR |
| `agent:queued` | 已授权任务，等待原生依赖完成或空闲执行槽位 |
| `agent:dispatching` | 已领取并派发，等待执行入口接收 |
| `agent:auth-*` | 内部认证槽位预留，由工作流维护 |
| `agent:to-issues` | 生成待审批拆票计划 |
| `agent:publish-tickets` | 确认计划并发布原生子任务和依赖 |
| `agent:in-progress` | 本轮自动实现正在执行 |
| `agent:blocked` | 本轮失败，查看运行日志后重试 |

首次运行 `Setup Agent Labels` 可创建缺少的标签，保留已有标签的配置。详情见 [GitHub Actions 与 Codex](./github-actions.md)。
