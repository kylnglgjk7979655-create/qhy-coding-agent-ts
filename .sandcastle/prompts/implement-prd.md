本轮只实现 child 指定的一个子 Issue。issue 是完整 PRD，children 列表按执行顺序排列，已关闭的子任务已在当前分支上完成。不要实现其他开放子任务，不改写既有历史。每轮修改叠加到同一个 PRD 分支。
只有 child 验收条件全部满足时输出 completed:true。前一轮已推送但未成功关闭子任务时，核实已经满足验收条件可不修改代码。禁止把不确定或未完成的需求报告为完成。
输出：{"summary":"本子任务的实现和验证证据","completed":true}。

按照已加载 pr 方法组织本轮摘要、验证证据和合并风险；可输出 prTitle 和 prBody 用于 PR 正文，描述父需求整体。prBody 不写 Closes/Fixes/Resolves 引用，父单和人工 QA 的关闭策略由发布端决定。
