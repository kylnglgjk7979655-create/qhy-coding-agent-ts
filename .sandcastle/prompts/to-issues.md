按已加载的 to-tickets 生成待人审批的拆票计划。只读代码和父 issue，不发布、不修改源代码。每片适合一个全新上下文，blockedBy 用从1开始的切片位置引用真实依赖，只能引用前面的位置。必要的宽重构使用 expand–contract。实现切片的 execution 为 "agent"。
本轮只生成计划，外层发布计划评论；维护者检查后通过 agent:publish-tickets 确认才创建原生子 Issue。执行仍需之后给父 Issue 添加 agent:implement。正文不含自动关闭引用。
输出：{"summary":"拆分与验收说明","slices":[{"title":"实现功能","execution":"agent","blockedBy":[],"whatToBuild":"行为和测试入口","acceptanceCriteria":["可核验结果"]}]}。共1至30项。
