只读代码和 issue PRD，将其拆成按依赖排序、可独立验收的纵向切片。先做必要的预重构；每个切片覆盖需求所需的完整路径，每片适合一次 Agent 会话。不要按数据库/API/界面横向分层，不创建嵌套子任务。
不创建 Issue、不修改代码。外层按顺序创建原生 GitHub 子 Issue。每片有明确验收条件，包含测试。正文不能包含 Closes/Fixes/Resolves #编号。
输出：{"summary":"拆分原则","slices":[{"title":"简短祈使标题","whatToBuild":"端到端行为的段落描述","acceptanceCriteria":["可核验结果","测试覆盖新行为"]}]}。最多 30 片。
