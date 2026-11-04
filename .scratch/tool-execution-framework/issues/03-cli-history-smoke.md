# 03：终端执行状态、历史兼容与冒烟

Type: task
Status: ready-for-agent
Blocked by: 01

## What to build

CLI 从实时事件展示工具名及开始、成功、失败、拒绝，不输出参数、内容、原始异常。同步冒烟判定为新的成功包装。旧历史不迁移，新结果可以保存、重载并继续使用。

## Acceptance

- 在独立 tests/tool-presentation.test.ts 复用 01 夹具验证实时状态和脱敏、旧新历史混存与续聊、本地工具冒烟。
- 修改 src/cli.ts 和 src/agent.ts 的冒烟检查；不要改动 02 所负责的配对和顺序代码。

## Comments

