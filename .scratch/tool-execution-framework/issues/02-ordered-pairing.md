# 02：串行批次与新增往返配对

Type: task
Status: resolved
Blocked by: 01

## What to build

使用 SDK toolCallConcurrency: 1 串行执行同批调用；普通失败继续。只校验当前新增往返的非空、唯一调用 ID 和一对一结果关联；可预先发现的 ID 错误在任何副作用前拒绝，不生成修复消息，不扫描旧历史。异常、取消和框架故障阻止后续模型请求。

## Acceptance

- 在独立 tests/tool-pairing.test.ts 中复用 01 夹具验证写后读的新内容、失败写后的旧内容或读取失败，以及同名不同 ID。
- 验证缺失、空、重复 ID 不执行文件操作或后续模型请求；覆盖实际可由公共接口触发的结果异常。
- 实现可编辑 src/agent.ts 和公共执行模块，避免修改 03 的 CLI 与冒烟代码。

## Comments

## Answer

在 `ToolLoopAgent` 中启用 `toolCallConcurrency: 1`，同批调用按模型顺序串行执行，普通工具失败仍作为当前调用结果并继续后续调用。OpenAI SSE 响应在工具批次完成前暂存工具帧、累计各工具索引的原始 ID；发现缺失、空或重复 ID 时，不释放该批次给 SDK，因此不会执行工具，也不会发起下一次模型请求。纯文本 SSE 事件仍逐事件转发。

通过 SDK 等待的 `onStepFinish` 校验新增调用与结果按 ID 一一覆盖；配对异常触发内部 abort 并保留轮次错误，阻止下一次模型请求。未扫描或改写旧历史。共享 HTTP 夹具扩展了 SSE 分片响应，新增 `tests/tool-pairing.test.ts` 覆盖写后读、失败写后读取旧内容、缺失/空/重复 ID 与跨帧 ID 累积，并验证 `finish_reason: stop` 但含工具调用时仍可正常执行。

验证：`pnpm typecheck`、`pnpm build`、`pnpm exec vitest run tests/tool-pairing.test.ts tests/agent-execution.test.ts` 通过（9 项）；`git diff --check` 通过。代码与测试见 [src/agent.ts](../../../src/agent.ts)、[tool-pairing.test.ts](../../../tests/tool-pairing.test.ts)。

