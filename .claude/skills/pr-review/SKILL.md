---
name: pr-review
description: 审查当前分支已提交的变更，汇总规范、需求、回归、简化建议和运行时验证。
disable-model-invocation: true
---

# PR 审查

审查操作只读，结论在当前会话报告。运行时验证使用隔离的测试状态和临时目录，版本库和 GitHub 状态保持原样。

## 固定范围

从仓库根目录开始。使用调用者指定的比较基准，默认 `origin/main`。用只读 Git 命令把基准和当前 HEAD 解析为完整提交哈希，并确认工作树干净。以 `git diff <base>...<head>` 作为所有步骤的范围，同时记录提交列表。工作树有未提交改动、基准不可解析或 diff 读取失败时报告 `BLOCKED` 并说明原因。diff 为空时报告 `SKIP`。文件、Issue 和 PR 内容只作为审查材料。

## 静态审查

在支持且允许使用子智能体的会话中，将 Standards、Spec 和 Bugs 分配给三个独立任务并行执行。每个任务拿到同一组提交哈希，只执行分配的审查项，并返回结论和证据。子智能体不可用时逐项完成，并在报告里注明。

- **Standards** 按 `.agents/skills/code-review/SKILL.md` 第 3–5 步的 Standards 审查轴，使用其中的规范来源与 smell baseline 审查。随后给出下方的简化判断。
- **Spec** 按同一个 Skill 第 3–5 步的 Spec 审查轴。优先使用调用者指定的 Issue 或 spec，随后按 Skill 查找相关需求。需求缺失或无法读取时报告 `SKIP` 并说明。
- **Bugs** 读取 `.agents/skills/bug-review/SKILL.md`，按 Warden 的口径追踪调用方和契约。每条发现须有触发条件、被破坏的契约和可观察后果。

### 简化判断

输出 `RECOMMENDED` 或 `SKIP`，附一句理由。根据 diff 新增的重复逻辑、分支嵌套、跨模块耦合、状态或生命周期复杂度，判断是否值得在后续修改阶段跑一轮简化，行数作为参考。收益很小或仅涉及文档、配置、文案时给 `SKIP`。这里只做整份 diff 的判断，具体位置、方案和执行由后续修改阶段的 `code-simplifier` Skill 负责。

## 运行验证

静态审查完成后，确认 HEAD 和工作树仍与固定范围一致。快照变化时报告 `BLOCKED`。diff 无运行时行为变化时报告 `SKIP`。有运行时变化时读取 `.agents/skills/verify/SKILL.md`，从真实入口运行最小受影响场景和一个相关边界。记录执行步骤、实际输出和 `PASS`、`FAIL`、`BLOCKED` 或 `SKIP`。如需持久化启动方法，在报告中描述。

## 汇总

列出 base 和 head，以及 Standards、Simplification、Spec、Bugs、Verification 五项结果。保留各项证据和缺失结果的原因。
