# TASK

对 PR #{{PR_NUMBER}}（branch `{{BRANCH}}`）执行 QA，并修复本轮发现的问题。

主 Agent 负责调度。每次启动新的 subagent，在 fresh context 中运行对应 skill，关闭主对话历史继承，显式传入任务所需的 Spec 和输入。本任务明确授权使用 QA、implement 和 CR subagent。

PR title: {{PR_TITLE}}
Fixed point: `main`
Initial HEAD: `{{INITIAL_HEAD}}`
Artifacts directory: `{{ARTIFACTS_DIRECTORY}}`

# SPEC

{{SPEC}}

# DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# QA PROCESS

1. 启动 **QA subagent**，使用 `$qa-only` skill。显式提供上方完整 Spec、固定比较基准 `main` 和独立报告目录。由它生成 QA plan、实际运行产品并报告结果；它只验收，不修改产品代码或测试。
2. 若全部必验项通过，汇总报告。缺少环境、凭据或明确预期时报告 blocked；与本次范围无关的问题只记录。
3. 有已复现的范围内缺陷时，在首次修复前固定 HEAD，逐项启动 **implement subagent**，使用 `$implement` skill。向它明确提供缺陷、复现步骤、预期结果和相关 Spec，只修复指定问题，执行项目检查并提交。实现 subagent 串行运行，主 Agent 不亲自修改产品代码。
4. 修复后启动 **CR subagent**，使用 `$code-review` skill。显式提供修复前 HEAD 作为 fixed point、同一份 Spec，以及 `CODING_STANDARDS.md`。CR skill 只审查、返回 findings；有效 findings 再交给新的 implement subagent 修复并提交，新增修改重新经过 CR。
5. 启动新的 **QA subagent**，再次使用 `$qa-only`，按原 QA plan 验证修复、受影响功能和相邻正常路径。代码未变且相关输入和环境未变的证据可沿用；有新增修改时重新审查和复验。

同一问题最多尝试三轮修复，CR 后继续修复也计入。仍未解决就停止，报告尝试结果和剩余问题；换 subagent 不重置次数。

每个 subagent 读取 `AGENTS.md`、相关领域文档和项目执行约定；实现及审查同时读取 `CODING_STANDARDS.md`。只向主 Agent 返回结果摘要、commit 和证据位置。

将最终 QA 结果、修复提交、CR 结论和未完成项汇总为 `{{ARTIFACTS_DIRECTORY}}/report.md`。仅全部必验项通过、修复经过 CR 且无未解决的有效 findings 时报告 pass；人工 QA 单列真实状态。

不 push、不编辑标签、不创建 GitHub 评论，不改变 PR Ready 状态；发布由调用方负责。

在最终摘要中记录实际验收的完整 HEAD、最后一次 CR 通过的完整 HEAD（无修复或未通过时为 null）、每个问题的累计修复次数、解决状态和提交，以及未解决的范围内 findings。达到三次仍未解决必须报告 fail，并写明达到最大次数及剩余问题；因环境阻塞而停下时保留原因。

完成后输出 `<promise>COMPLETE</promise>`。fail / blocked 也是有效验收结果，必须如实保留。
