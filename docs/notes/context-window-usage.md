# Codex 上下文窗口用量调查

## 结论

失败运行 [42854226215](https://github.com/kylnglgjk7979655-create/qhy-coding-agent-ts/actions/runs/42854226215) 在完成一轮后输出“本次运行未返回上下文窗口数据”。根因在采集链路：实现 workflow 使用 Sandcastle `noSandbox()`；Sandcastle v0.14.0 只在有 bind-mount handle 时捕获 Codex rollout 文件并运行 `parseSessionContextWindow`，而 no-sandbox 没有该 handle。该版本的 Codex stdout `parseStreamLine` 能读取 `turn.completed.usage`，但没有处理 `event_msg` / `token_count`。因此 Codex JSONL 中的逐请求用量没有进入迭代结果。

Codex rollout 的 `event_msg` / `token_count` 含有 `info.last_token_usage.input_tokens`，以及可能缺失的 `info.model_context_window`。Sandcastle 的 `ContextWindow` 定义将请求输入 token 数（包含缓存）作为窗口占用；代码只取该字段及上游给出的上限，不使用累计用量，也不推断模型上限。

## 修复与边界

Codex provider 在现有 stdout 解析边界补充 `token_count` 事件解析。Sandcastle 每轮保留最后一个上下文窗口事件；Actions 汇报选取最近一个有有效请求 token 数的迭代，并显示迭代序号。如果上限缺失，只显示请求 token 数；如果全部迭代都缺失有效数据，明确显示上游未提供数据。这样较早迭代的数据不会被误标成最后一轮请求。

## 可重复验证

- `pnpm exec vitest run tests/codex-context-usage.test.ts tests/implement-context-report.test.ts`：验证 Codex JSONL 事件采集、无效／部分数据处理、末轮缺数据回退及全部缺失提示。
- 原始失败运行日志中的 `Codex 上下文用量：本次运行未返回上下文窗口数据。` 是修改前证据；合并后的定向测试验证公开 provider 解析及 Actions 报告行为。

人工 QA 尚未执行。若 Codex 不发送有效 `token_count` 事件（或事件缺少有效 `last_token_usage.input_tokens`），仍无法展示上下文占用；若未提供 `model_context_window`，上限与百分比不可用。
