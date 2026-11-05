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

GitHub 上给开放 Issue 添加 `ready-for-agent` 会启动 Codex；`agent:implement` 是等价入口。仅本地 Markdown 文件中的 `Status: ready-for-agent` 不会触发 Actions。

| 标签 | 含义 |
| --- | --- |
| `agent:implement` | 启动 Codex 实现 |
| `agent:in-progress` | 本轮自动实现正在执行 |
| `agent:blocked` | 本轮失败，查看运行日志后重试 |

首次运行 `Setup Agent Labels` 可创建缺少的标签，保留已有标签的配置。详情见 [GitHub Actions 与 Codex](./github-actions.md)。
