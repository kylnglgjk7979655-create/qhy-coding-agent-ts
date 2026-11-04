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

在 `ToolLoopAgent` 中启用 `toolCallConcurrency: 1`，同批调用按模型顺序串行执行，普通工具失败仍作为当前调用结果并继续后续调用。OpenAI SSE 响应按工具索引记录每个调用首次出现时的原始 ID，首次帧缺失/空 ID、跨索引重复 ID、同索引重复调用起始帧均立即拒绝；不等待 SDK 合成或归一 ID，不释放该批次给 SDK，也不发起下一次模型请求。纯文本 SSE 事件仍逐事件转发，缓冲区内已有完整事件优先处理。

通过 SDK 等待的 `onStepFinish` 校验新增调用与结果按 ID 一一覆盖；配对异常触发内部 abort 并保留轮次错误，阻止下一次模型请求。未扫描或改写旧历史。共享 HTTP 夹具扩展了 SSE 分片、合帧和延迟结束响应；`tests/tool-pairing.test.ts` 全部通过编译后 CLI + 本地 HTTP 服务覆盖写后读、失败写后读取旧内容或再次失败、缺失/空/重复 ID、跨帧参数续片成功与重复 ID 拒绝、同名工具的不同 ID、`finish_reason: stop` 工具调用、首次帧缺失 ID 后续补帧、同索引重复 ID 两次调用，以及文本事件已到达但响应流尚未结束时 CLI 立即输出。两个审计用例在修复前均稳定复现了文件副作用；修复后均在工具执行前被拒绝，文件未创建。

验证：`pnpm typecheck`、`pnpm build`、`pnpm exec vitest run tests/tool-pairing.test.ts tests/agent-execution.test.ts tests/tool-presentation.test.ts` 通过（17 项）；`git diff --check` 通过。配对验收通过编译 CLI 边界，通知回调异常仍由规格允许的公共 `runAgent` 定向测试覆盖。代码与测试见 [src/agent.ts](../../../src/agent.ts)、[tool-pairing.test.ts](../../../tests/tool-pairing.test.ts)。

