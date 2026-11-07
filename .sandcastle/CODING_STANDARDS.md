# 项目编码约定

领域词汇来自 `GLOSSARY.md`，相关决策来自 `docs/adr/`。遵守仓库 `AGENTS.md` 和现有模块的约定；项目说明及面向维护者的报告默认使用中文。

- 使用 TypeScript、ESM，沿用现有类型检查配置；相对导入使用 `.js` 后缀。
- 按任务范围修改代码；为行为变化选择有意义的测试，通过公开入口验证可观察行为。
- 提交前运行 `pnpm typecheck`，按修改范围运行聚焦测试。完整检查为 `pnpm check`，演示项目测试为 `pnpm demo:test`。
- 使用 conventional commit。Agent 在当前分支提交；推送、PR、标签和评论由 workflow 负责，具体交付协议以各阶段 prompt 为准。
