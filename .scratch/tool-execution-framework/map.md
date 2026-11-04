# 工具执行框架实现地图

## Notes

- 规格：[spec.md](spec.md)。集成分支：`feat/tool-execution-framework`。
- 起点：`becf2db`，保留现有领域术语和 ADR 文档。
- 测试边界已由规格 Testing Decisions 确认：编译后 CLI、本地 HTTP 模型服务、临时工作区；通知失败允许使用公共 `runAgent` 入口。

## Decisions-so-far

- 01 为公共基础；02 与 03 在其后并行；04 在两者完成后做停止边界和综合验收。
- 01 已完成统一工具结果、SDK 参数/未知工具拒绝、执行事件与共享 HTTP 夹具；实现和验证记录见[工单 01](issues/01-unified-execution.md)。smoke 包装检查由 03 更新。
- 02 已完成串行批次与新增往返配对验证，包含 SSE 原始 ID 预检和每步结果配对门禁；实现、测试与验证记录见[工单 02](issues/02-ordered-pairing.md)。
- 03 已完成 CLI 实时状态、历史兼容验证及 smoke 成功包装适配；旧历史原样保留，新格式工具结果可保存并续聊。实现与验证见[工单 03](issues/03-cli-history-smoke.md)。
- 04 已完成停止边界与参数拒绝回归，并隔离异步执行事件通知 rejection；SDK middleware 在模型 stream `error` part 到达工具执行前终止轮次。`pnpm check` 共 65 项通过，真实模型 smoke 未运行。实现与验证见[工单 04](issues/04-stopping-regressions.md)及[验收记录](../../docs/verification.md)。

## Fog

- 无待用户确认项。
