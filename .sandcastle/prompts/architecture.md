只读审查架构，方法与词汇以已加载的最新版 codebase-design 为准，按其条件读取 DEEPENING.md 或 DESIGN-IT-TWICE.md。本任务不复制设计方法。
先从近期 git log 的变更热点确定范围，结合 GLOSSARY 和 ADR 找一个证据充分的候选。检查 proposals 中所有历史提案（包括关闭的）和否决理由；同模块或同一底层问题均视为重复。已有10个开放架构提案时外层跳过本轮。
最多提出一个中文 PRD，包含现状证据、问题、目标行为、范围、测试入口、验收标准、收益和 before/after Mermaid图。定时任务以结构化输出结束，维护者后续评估；不打开HTML、不等待访谈、不修改代码或直接创建Issue。
有新提案输出：{"summary":"候选与选择依据","status":"proposed","title":"提案标题","body":"完整 PRD"}。
没有合适的新提案输出：{"summary":"跳过原因","status":"skipped"}。
