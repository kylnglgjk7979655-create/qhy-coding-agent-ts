# 仓库 skill 与云端 prompt 的项目适配

本地 skill 保存在 `.agents/skills/`，来源和版本由 `UPSTREAM.json` 固定，上游原文及引用文件保持完整。云端执行方法维护在 `.sandcastle/prompts/`，以 Sandcastle 官方模板为骨架，将各阶段需要的 skill 方法适配到完整 prompt；运行时不读取、安装或更新 skill。

## 需求、规划与授权

- 云端以 GitHub Issues 中的需求和规格为准，原生父子关系及 `blocked by` 是调度依据；正文中的列表和文字依赖只作说明。本地 tracker 约定见 [issue-tracker.md](issue-tracker.md)。
- `ready-for-agent` 仅表示需求准备完成。`agent:implement`、`agent:bugfix`、`agent:code-design` 或显式手动运行才授权相应任务。
- to-spec 从已有讨论产生规格。to-tickets 对应云端 `agent:to-issues`：只生成完整切片计划和依赖，供人审批；`agent:publish-tickets` 发布已批准的计划，不启动实现。
- 给父规格添加 `agent:implement` 后，全部开放 Agent 子任务加入 `agent:queued`；首次检查无依赖节点，后续按原生依赖释放任务。每个子任务拥有自己的工作分支和 PR。
- 人工 QA 使用 `ready-for-human`，始终由人执行和记录环境、版本、步骤、结果。误加执行或排队标签也不能由模型领取。父规格和 QA 不因子任务 PR 合并而提前关闭，最后由人验收父规格。

## 云端任务边界

| 入口 | 方法与交付 |
| --- | --- |
| implement | TDD，完成当前 Issue 的功能，交付通过验证的代码 |
| bugfix | 反馈循环、最小复现、证伪根因、回归测试和修复，交付通过验证的代码 |
| code-design | 只读探索、方案比较、推荐接口和实施建议；方案发布到原 Issue 评论，保持 Issue 开放 |
| review | Standards、Spec 独立新会话只读报告，外层再调用修复阶段 |
| implement-pr | 根据已有 PR 反馈修复或解释，并验证 |
| update-branch | 解决外层已尝试合并产生的冲突，验证两侧行为 |
| to-issues | 生成待审批的纵向切片，不创建 Issue、不改代码 |
| architecture | 从代码热点主动发现设计机会，最多提交一份新 PRD 提案 |

`code-design` 针对已指定的问题；`architecture` 主动寻找候选。两者都只交付方案。设计通过后，由人将批准的实现要求交给 implement，设计阶段不自动开始实施。

## Prompt 组合与来源

`.sandcastle/prompts.ts` 从可信控制脚本版本读取公共上下文、任务模板、相应方法和验证要求，再追加本轮任务 JSON。运行时不解析 skill 原文，不依赖正文中进一步读取 skill 的指针。工作区仍用于读取源码、领域文档和项目规范。

方法分别来自固定的 tdd、diagnosing-bugs、codebase-design、code-review、to-tickets；只纳入当前阶段适用的内容，并展开必需的参考方法。implement-spec 的跨任务调度、CR 和 PR 编排不进入实现 prompt。PR 的摘要、验证与风险由实施结果和可信发布模板提供，发布端管理关闭引用。

Codex 启动参数关闭当前工作区中仓库 skills 的自动加载，避免旧端到端 skill 再次触发。仓库没有 `.agents/skills` 时，云端仍可通过完整 prompt 执行。上游升级后人工检查方法差异、更新对应 prompt，并运行验收；不在 CI 自动覆盖。

参考：
- [Sandcastle 实现模板](https://github.com/mattpocock/sandcastle/blob/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8/.sandcastle/agent-workflows/implement/prompt.md)
- [Sandcastle simple-loop 模板](https://github.com/mattpocock/sandcastle/blob/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8/src/templates/simple-loop/prompt.md)
- [Matt 的依赖晋级工作流](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-promote-queued.yml)

## 验证与发布

涉及代码修改的任务在本次 Agent 会话内完成验收、相关测试、`pnpm check` 和 `pnpm demo:test`。失败后定位、修复并重跑；外层 job 的独立验证不能替代本轮修复。无须修改代码的审查也运行项目验证，确保交付依据充分。

只有验收及检查通过才能输出 `completed:true`。真实阻塞输出 `completed:false`，给出证据、已尝试处理、未完成项和恢复条件；结果校验拒绝发布，外层标记失败。`Output.object` 的格式校验不是测试修复循环。

实现和修复保留工作区修改，Agent 保持 HEAD 不变。提交、推送、创建或更新 PR、发布评论、审查接续由可信外层 job 执行。未通过检查不发布成功结果。普通 Issue 和子 Issue 的 PR 使用 `Closes #当前任务`，子 PR 以 `Part of #父规格` 关联父任务。

## 依赖晋级与并行

Issue 以完成状态关闭时，通过 `blocking` 找出其下游，重新检查下游全部 `blockedBy`。只有依赖全部完成、任务已排队、非人工且未执行或失败的节点才晋级。多个就绪任务分别派发，在空闲认证槽位允许时并行，不按子任务列表串行等待。`not_planned` 不算依赖完成。

标签用于选择任务及显示状态，自动接续使用 `workflow_dispatch`，不依赖 GITHUB_TOKEN 修改标签再触发工作流。一次领取先标记 `agent:dispatching` 并预留槽位，再移除 queued、派发；派发失败恢复 queued。实际执行改为 in-progress，结束释放槽位；其他就绪任务可继续。手动和定时扫描补齐零依赖节点、依赖关系变更或错过的事件。

同一份订阅登录态从恢复到回存保持串行；不同独立登录态槽位可以并行。没有配置槽位池时保持单槽位，不冒险并发刷新同一登录。配置和恢复操作见 [GitHub Actions](github-actions.md)。
