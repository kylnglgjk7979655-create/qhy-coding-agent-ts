# TASK

审查 pr 相对 baseSha 的三点 diff，并读取 git log baseSha..HEAD。外层为 Standards、Spec 各启动一个独立新会话，再将两份报告交给修复阶段。每次只执行外层指定的阶段，不自行启动其他审查会话。

## Standards（只读）

收集所有适用的仓库规范，必须包括存在的 CODING_STANDARDS.md、CONTRIBUTING.md 和 AGENTS.md。逐文件或代码块报告规范违反，引用文件和具体规则；跳过工具已覆盖的格式与静态检查。

同时检查以下启发式问题；仓库规则优先，气味必须以证据和取舍说明，不能当硬性违规：
- Mysterious Name：名称隐藏意图；改善名称或澄清职责。
- Duplicated Code：重复逻辑；收拢真正相同的行为。
- Feature Envy：频繁操作其他模块的数据；把行为放回合适模块。
- Data Clumps：字段成组传播；考虑明确的数据结构。
- Primitive Obsession：原始值承载领域规则；考虑领域类型。
- Repeated Switches：相同分派重复；考虑集中映射或多态。
- Shotgun Surgery：一个变化散落多处；集中职责。
- Divergent Change：一个模块因多种原因变化；拆分职责。
- Speculative Generality：没有需求支持的抽象；删除多余层次。
- Message Chains：调用者依赖长链导航；隐藏导航细节。
- Middle Man：纯转发模块；简化无价值的间接层。
- Refused Bequest：继承后拒绝大部分约定；考虑组合。

## Spec（只读）

以 linkedIssues 提供的当前需求、验收要求和实际依赖为依据；父规格是背景，不要求当前子任务实现全部兄弟任务。报告缺失或部分实现、未经要求的范围扩大、实现与要求矛盾，逐项引用需求。未提供规格时明确报告 no spec available，不伪造需求。

## 修复阶段

接收两轴报告及 feedback。修复有证据的正确性和代码质量问题，保持功能和当前 Issue 范围；无法决定的需求歧义交给人。按需要补充回归测试，执行下文全部验证。允许没有代码修改。

inlineComments 只引用最终差异右侧存在的行；replies 使用输入中 PR thread 评论的数字 id，不替审核者 resolve thread。
输出 <output>{"summary":"修复、验证和遗留问题","completed":true,"inlineComments":[],"replies":[]}</output>。只读轴的输出格式由外层单独指定。
