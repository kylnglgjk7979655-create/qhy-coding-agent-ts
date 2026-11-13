# 上下文窗口用量调查（历史记录）

> 本记录描述迁移前的 Codex 订阅实现。2026-11 已改用 Claude Code + Anthropic 兼容端点，Codex rollout 相关细节不再适用；当前实现只从 Sandcastle 流事件读取 `contextWindow`，不使用 session 文件。历史结论保留供追溯。

## 结论

失败运行 [42854226215](https://github.com/kylnglgjk7979655-create/qhy-coding-agent-ts/actions/runs/42854226215) 在完成一轮后输出“本次运行未返回上下文窗口数据”。根因在采集链路：实现 workflow 使用 Sandcastle `noSandbox()`；Sandcastle v0.14.0 只在有 bind-mount handle 时捕获 Codex rollout 文件并调用 `parseSessionContextWindow`，no-sandbox 不会执行这段捕获流程。Codex `exec --json` 的 stdout 解析处理 `turn.completed.usage` 等执行事件，而 `event_msg` / `token_count` 是 rollout JSONL 事件。因此在 stdout 解析器中添加 `token_count` 处理仍拿不到实际用量。

Codex rollout 的 `event_msg` / `token_count` 含有 `info.last_token_usage.input_tokens`，以及可能缺失的 `info.model_context_window`。Sandcastle `codex()` 已提供 rollout 解析器和 `sessionStorage.readHostSession`；no-sandbox 下 Codex CLI 直接将 rollout 写入配置的主机 `CODEX_HOME/sessions`。当时的实现按最后一次迭代的 session ID 读取该 rollout，再调用 provider 的解析器。Sandcastle 的 `ContextWindow` 定义将请求输入 token 数（包含缓存）作为窗口占用；代码只取该字段及上游给出的上限，不使用累计用量，也不推断模型上限。

## 当前实现

改用 `claudeCode()` 后，`implement.ts` 只从 `result.iterations[].contextWindow` 取最近一次有有效 token 数的迭代；Claude 流事件由 Sandcastle 的 `parseClaudeContextWindow` 汇总输入与缓存 token。上游不给模型上限时只显示 token 数，全部缺失时显示“上游未提供上下文窗口数据”。

## 可重复验证

- `pnpm exec vitest run tests/implement-context-report.test.ts`：验证末轮缺数据回退、上限缺失与全部缺失提示。
- 迁移前的 Codex rollout 验证（`tests/codex-context-usage.test.ts`）已随实现删除。

人工 QA 尚未执行。若上游不发送有效 token 用量事件，仍无法展示上下文占用；若未提供模型上限，上限与百分比不可用。