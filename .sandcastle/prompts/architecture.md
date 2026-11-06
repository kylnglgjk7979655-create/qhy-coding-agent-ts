# TASK

只读探索架构，从近期 git log 和变更热点选一个证据充分的改进候选。读取 proposals 中包括关闭提案的历史及否决理由，同模块或同底层问题视为重复。已有 10 个开放提案时跳过。

使用下文设计方法，最多提出一个中文 PRD：现状证据、问题、目标行为、范围、推荐方案、测试入口、验收标准、收益和 before/after Mermaid 图。维护者后续评估，本轮保留源代码不变。

输出 <output>{"summary":"候选和选择依据","status":"proposed","title":"提案标题","body":"完整 PRD"}</output>。
没有合适的新候选时输出 <output>{"summary":"跳过原因","status":"skipped"}</output>。
