# 03：终端执行状态、历史兼容与冒烟

Type: task
Status: resolved
Blocked by: 01

## What to build

CLI 从实时事件展示工具名及开始、成功、失败、拒绝，不输出参数、内容、原始异常。同步冒烟判定为新的成功包装。旧历史不迁移，新结果可以保存、重载并继续使用。

## Acceptance

- 在独立 tests/tool-presentation.test.ts 复用 01 夹具验证实时状态和脱敏、旧新历史混存与续聊、本地工具冒烟。
- 修改 src/cli.ts 和 src/agent.ts 的冒烟检查；不要改动 02 所负责的配对和顺序代码。

## Comments

## Answer

CLI 通过 01 提供的 `onToolEvent` 实时显示工具开始、成功、失败和拒绝状态，展示中文状态及工具名，不输出调用参数、文件内容或原始异常。冒烟验证现在要求 `is_error: false` 且 `output.content` 与随机探针一致，并继续检查最终回答包含探针。

新增 `tests/tool-presentation.test.ts`：使用共享本地 OpenAI 夹具和编译后 CLI 验证事件在最终模型响应返回前可观察、每次调用只产生一个终结状态、输出脱敏；真实 SDK 旧格式的 tool-call/tool-result 历史原样保留，新格式工具结果保存、重载后可继续对话；本地工具冒烟识别统一包装。README 已同步终端状态说明，真实命令 `pnpm smoke` 和直接 CLI 冒烟命令保持不变。

验证：`pnpm check` 通过，类型检查通过，4 个测试文件共 38 项通过。真实模型 `pnpm smoke` 命令保留，未在本地夹具验证之外调用真实服务。
