# 04：停止边界与完整回归验收

Type: task
Status: resolved
Blocked by: 02, 03

## What to build

基于完整实现补齐规格停止边界与文件边界回归，修复验收发现的问题，并记录可重复验证方式。

## Acceptance

- 覆盖整轮超时后继续输入、maxSteps 后无后续请求、失败轮次不保存、取消后不启动工具或模型请求。
- 保留工作区边界、符号链接、缺失父目录和文件副作用不回滚的既有语义。
- pnpm check 通过；本地冒烟通过；真实 pnpm smoke 命令保留，常规测试不要求真实服务。
- 更新 docs/verification.md，记录本次实际验证及限制。

## Comments

## Answer

补齐 read_file 与 write_file 的参数拒绝矩阵：缺少必填字段、字段类型错误、空 path、无效 JSON 均通过编译后 CLI + 本地 HTTP fixture 验证为 `INVALID_TOOL_ARGUMENTS`，工具不产生文件修改，结果仍关联原调用 ID 并进入后续模型请求。保留既有读写额外字段拒绝；CLI 测试确认 runtimeInfo 接受额外对象字段。修复 `onToolEvent` 只隔离同步异常的问题：回调返回 Promise 时不等待通知，异步 rejection 也被捕获并输出诊断，不影响工具结果或后续调用。

停止边界覆盖整轮 timeout 后继续下一轮、maxSteps 后停止当前轮次、工具开始后取消不会启动同批排队工具或下一次模型请求。取消工具批次以公共 `runAgent` 定向测试覆盖：CLI seam 无法稳定地在某项工具刚启动时注入同步取消信号；该测试用取消回调触发点验证同批排队边界。另新增编译后 CLI 回归：有效写工具调用后收到损坏 provider stream，SDK middleware 在归一化的 `error` part 处立即 abort；工具未执行、没有下一次模型请求、失败轮次不保存，CLI 可继续下一条输入。HTTP 401/403 与 500 的 AUTH_ERROR/PROVIDER_ERROR 分类和恢复行为均有回归。成功写入后下一次 provider 请求失败时文件副作用保留、失败轮次不入历史。原有工作区边界、符号链接、缺失父目录、SIGINT 等覆盖继续通过。

验证：`pnpm check` 通过，类型检查、构建及 5 个测试文件共 65 项通过；`git diff --check` 通过。真实模型 `pnpm smoke` 命令保留，本次未调用真实模型服务。详细记录见 [docs/verification.md](../../../docs/verification.md)。
