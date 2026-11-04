# 工具执行框架实现地图

## Notes

- 规格：[spec.md](spec.md)。集成分支：`feat/tool-execution-framework`。
- 起点：`becf2db`，保留现有领域术语和 ADR 文档。
- 测试边界已由规格 Testing Decisions 确认：编译后 CLI、本地 HTTP 模型服务、临时工作区；通知失败允许使用公共 `runAgent` 入口。

## Decisions-so-far

- 01 为公共基础；02 与 03 在其后并行；04 在两者完成后做停止边界和综合验收。
- 01 已完成统一工具结果、SDK 参数/未知工具拒绝、执行事件与共享 HTTP 夹具；实现和验证记录见[工单 01](issues/01-unified-execution.md)。smoke 包装检查由 03 更新。

## Fog

- 无待用户确认项。
