# 来源与适配

本 skill 是项目适配，审查方法来自 Anthropic 官方 `code-review` command 的 Bug 部分；组织方式参考 Matt Pocock 的 `code-review` 与 `writing-for-agents`。两者不是同一个上游 skill。

## Anthropic

- [固定原文](https://github.com/anthropics/claude-plugins-official/blob/e6143c9807a001832badb63e89d58ffe25d542ec/plugins/code-review/commands/code-review.md)
- commit：`e6143c9807a001832badb63e89d58ffe25d542ec`
- 文件：`plugins/code-review/commands/code-review.md`
- Git blob：`8d1533fa424c89a2790541fd7687270be3993397`
- [许可证](https://github.com/anthropics/claude-plugins-official/blob/e6143c9807a001832badb63e89d58ffe25d542ec/LICENSE)：Apache-2.0。

对应关系：原文第 4 步的 Agent 3 → Diff Agent；Agent 4 → Code Agent；第 5 步 → 每个候选分别启动新的验证 Agent；第 6 步及 false positives 列表 → 筛选与排除；第 7 步 → 输出报告。

原文的关键指令：

> Agent 3: “Focus only on the diff itself without reading extra context.”
>
> Agent 4: “Only look for issues that fall within the changed code.”
>
> Step 5: “For each issue found in the previous step by agents 3 and 4, launch parallel subagents to validate the issue.”
>
> Step 6: “Filter out any issues that were not validated in step 5.”

保留原文的高信号取向，包括排除依赖特定输入或状态推测的潜在问题。这是一份保守的 Bug 审查，不承诺穷尽所有条件性缺陷。

项目适配：增加本地未提交改动的输入分支与快照说明；使用调用方模型，代替上游固定 Opus；规范与需求审查交给 Matt `code-review`；移除 PR 资格预检和 GitHub 评论发布步骤。没有引入 `pr-review-toolkit` 的置信度评分、修复循环或机器门禁契约。

## Matt Pocock

[固定参考](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d)：采用固定比较基准、并行独立上下文、明确 brief、步骤完成条件和简洁汇总的组织方式。Matt 上游 skill 文件保持原文；本 skill 使用中文编写。
