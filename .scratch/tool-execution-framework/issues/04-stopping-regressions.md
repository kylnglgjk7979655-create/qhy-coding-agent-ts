# 04：停止边界与完整回归验收

Type: task
Status: ready-for-agent
Blocked by: 02, 03

## What to build

基于完整实现补齐规格停止边界与文件边界回归，修复验收发现的问题，并记录可重复验证方式。

## Acceptance

- 覆盖整轮超时后继续输入、maxSteps 后无后续请求、失败轮次不保存、取消后不启动工具或模型请求。
- 保留工作区边界、符号链接、缺失父目录和文件副作用不回滚的既有语义。
- pnpm check 通过；本地冒烟通过；真实 pnpm smoke 命令保留，常规测试不要求真实服务。
- 更新 docs/verification.md，记录本次实际验证及限制。

## Comments

