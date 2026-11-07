# 仓库内 skills

本目录保留本地可调用的固定 skills。版本与逐文件 SHA256 记录在 [UPSTREAM.json](UPSTREAM.json)，许可证见 [LICENSE.mattpocock](LICENSE.mattpocock)。云端执行以 Sandcastle 官方阶段 prompt 为准，不固定拼接这些 skills。

| Skill | 作用 | 来源 |
| --- | --- | --- |
| code-review | 规范、需求两个独立视角审查 | Matt 固定版本 |
| tdd | 通过公共接口测试行为，逐条 red→green | Matt 固定版本 |
| diagnosing-bugs | 可复现反馈、最小化、诊断、回归 | Matt 固定版本 |
| codebase-design | 共享设计词汇与深化方法 | Matt 固定版本 |
| to-spec | 从讨论整理规格 | Matt 固定版本 |
| pr | 变更、证据和合并风险 | Matt 固定版本 |
| implement | 根据规格或工单实现工作 | 本机快照，含用户定制 |
| implement-spec | 根据任务依赖图实现规格 | 本机已安装版本快照 |
| to-tickets | 按依赖图拆分垂直切片 | 本机已安装版本快照 |

执行时先读取 [项目适配](../../docs/agents/skill-execution.md)。更新上游时按固定 commit 复制完整目录，包括参考文档、脚本、agents 配置及 credits；更新来源和文件校验值，通过 PR 审核。项目特有规则集中在项目适配和任务入口，避免直接改动上游原文。

`implement` 按用户要求移除了完成后自动调用 `code-review` 的步骤，并补充了关键决策、约束和变通方案的注释要求。来源校验值及本地差异记录在 `UPSTREAM.json` 的 `localSnapshots.implement`。其他固定上游文件保持原文。云端拆票审批和依赖调度的执行约定见 [项目适配](../../docs/agents/skill-execution.md)。
