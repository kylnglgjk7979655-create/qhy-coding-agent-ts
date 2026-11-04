# 02：串行批次与新增往返配对

Type: task
Status: ready-for-agent
Blocked by: 01

## What to build

使用 SDK toolCallConcurrency: 1 串行执行同批调用；普通失败继续。只校验当前新增往返的非空、唯一调用 ID 和一对一结果关联；可预先发现的 ID 错误在任何副作用前拒绝，不生成修复消息，不扫描旧历史。异常、取消和框架故障阻止后续模型请求。

## Acceptance

- 在独立 tests/tool-pairing.test.ts 中复用 01 夹具验证写后读的新内容、失败写后的旧内容或读取失败，以及同名不同 ID。
- 验证缺失、空、重复 ID 不执行文件操作或后续模型请求；覆盖实际可由公共接口触发的结果异常。
- 实现可编辑 src/agent.ts 和公共执行模块，避免修改 03 的 CLI 与冒烟代码。

## Comments

