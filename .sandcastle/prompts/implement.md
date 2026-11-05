实现上下文 issue 的完整需求。修复 bug 时先用回归测试重现再修复。保留修改供外层导出补丁。
输出：{"summary":"修改和验证结果"}。需求无法完成时让执行失败。

按照已加载 pr 方法组织本轮摘要、验证证据和合并风险；可输出 prTitle 和 prBody 用于 PR 正文，描述父需求整体。prBody 不写 Closes/Fixes/Resolves 引用，父单和人工 QA 的关闭策略由发布端决定。
