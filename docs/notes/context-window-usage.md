# Codex 上下文窗口用量调查

## 结论

失败运行 [42854226215](https://github.com/kylnglgjk7979655-create/qhy-coding-agent-ts/actions/runs/42854226215) 在完成一轮后输出“本次运行未返回上下文窗口数据”。根因在采集链路：实现 workflow 使用 Sandcastle `noSandbox()`；Sandcastle v0.14.0 只在有 bind-mount handle 时捕获 Codex rollout 文件并调用 `parseSessionContextWindow`，no-sandbox 不会执行这段捕获流程。Codex `exec --json` 的 stdout 解析处理 `turn.completed.usage` 等执行事件，而 `event_msg` / `token_count` 是 rollout JSONL 事件。因此在 stdout 解析器中添加 `token_count` 处理仍拿不到实际用量。

Codex rollout 的 `event_msg` / `token_count` 含有 `info.last_token_usage.input_tokens`，以及可能缺失的 `info.model_context_window`。Sandcastle `codex()` 已提供 rollout 解析器和 `sessionStorage.readHostSession`；no-sandbox 下 Codex CLI 直接将 rollout 写入配置的主机 `CODEX_HOME/sessions`。实现现在按最后一次迭代的 session ID 读取该 rollout，再调用 provider 的解析器。Sandcastle 的 `ContextWindow` 定义将请求输入 token 数（包含缓存）作为窗口占用；代码只取该字段及上游给出的上限，不使用累计用量，也不推断模型上限。

## 修复与边界

Actions 汇报优先读取最后一次迭代对应 session 的 rollout，并显示该迭代序号；rollout 不可读或没有有效数据时，回退到流事件中最近一个有有效 token 数的迭代并显示其序号。如果上限缺失，只显示请求 token 数；如果全部迭代都缺失有效数据，明确显示上游未提供数据。

## 可重复验证

- `pnpm exec vitest run tests/codex-context-usage.test.ts tests/implement-context-report.test.ts`：验证 Sandcastle provider 的 rollout 解析、workflow 从最后一次迭代 session 获取数据、末轮缺数据回退及全部缺失提示。
- 可重复的依赖源码证据：锁定的 `@ai-hero/sandcastle@0.14.0` 中 `codex()` 提供 `parseCodexSessionContextWindow` 与 `readHostSession`；orchestrator 仅在存在 bind-mount handle 时捕获 session 并运行该解析器，而本 workflow 使用 `noSandbox()`。Codex `exec --json` 的顶层事件定义不含 `event_msg`；rollout 解析器则按 `event_msg` / `token_count` 读取字段。原始失败运行日志是修改前的运行证据。

人工 QA 尚未执行。若 Codex 不发送有效 `token_count` 事件（或事件缺少有效 `last_token_usage.input_tokens`），仍无法展示上下文占用；若未提供 `model_context_window`，上限与百分比不可用。
