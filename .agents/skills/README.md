# 仓库内 skills

本地与 Actions 共同使用本目录的已提交内容。上游版本与逐文件 SHA256 记录在 [UPSTREAM.json](UPSTREAM.json)，许可证见 [LICENSE.mattpocock](LICENSE.mattpocock)。每轮任务无需访问 skills.sh、插件市场或下载 skill。

| Skill | 作用 | 来源 |
| --- | --- | --- |
| code-review | 规范、需求两个独立视角审查 | Matt 固定版本 |
| tdd | 通过公共接口测试行为，逐条 red→green | Matt 固定版本 |
| diagnosing-bugs | 可复现反馈、最小化、诊断、回归 | Matt 固定版本 |
| codebase-design | 共享设计词汇与深化方法 | Matt 固定版本 |
| to-spec | 从讨论整理规格 | Matt 固定版本 |
| pr | 变更、证据和合并风险 | Matt 固定版本 |
| implement-spec | 根据任务依赖图实现规格 | 本机已安装版本快照 |
| to-tickets | 按依赖图拆分垂直切片 | 本机已安装版本快照 |

执行时先读取 [项目适配](../../docs/agents/skill-execution.md)。更新上游时按固定 commit 复制完整目录，包括参考文档、脚本、agents 配置及 credits；更新来源和文件校验值，通过 PR 审核。项目特有规则集中在项目适配和任务入口，避免直接改动上游原文。

架构审查直接复用最新版 codebase-design，任务提示词只保留定时、去重、候选选择和输出规则。没有重复的 improve-codebase-architecture-project skill。拆票使用 to-tickets；云端以串行任务调度适配 implement-spec。
