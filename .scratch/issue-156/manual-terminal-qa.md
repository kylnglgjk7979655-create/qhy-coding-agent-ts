# Issue #156 本地终端验收记录

执行方式：在本仓库 `dist/cli.js` 与本地 OpenAI 兼容夹具上，用 macOS `script` 建立真实 PTY，由 agent 按计划写入键盘序列完成。没有使用真实模型或真实凭据，也不冒充人类手动操作。交互终端中的键盘路径（数字选择 + 回车、原地刷新、会话批准）已在同一 PTY 中实际触发。

工作区：`.scratch/issue-156/manual-workspace-4`（`HOME` 也隔离到该目录）。
模型夹具：`tests/helpers/local-openai-fixture.ts`，第一个请求执行 `printf hello > manual-first.txt`，第二个执行 `printf world > manual-second.txt`，第三个写入 `manual-note.txt`。

键盘序列：输入需求 → `3` + Enter（本会话始终批准 Bash）→ `1` + Enter（批准 write_file）→ `/exit`。

清理 ANSI 控制符后的终端记录如下。相邻的重复工具行来自原地重绘（同一屏幕行先显示运行中、再显示成功），不是额外堆叠的新行。

```text
> 执行两步命令并写入文件

[人工审批 1] Bash（调用 manual-bash-1；最多等待 20000ms）
{
  "command": "printf hello > manual-first.txt"
}
实际工作目录：…/.scratch/issue-156/manual-workspace-4
沙箱执行模式：沙箱外执行
豁免申请：未申请
❯ 1. 批准本次
  2. 拒绝本次
  3. 本会话始终批准 Bash（仅跳过默认审批）
使用 ↑/↓ 或数字键选择，回车确认，Esc 拒绝本次。
3  1. 批准本次
  2. 拒绝本次
❯ 3. 本会话始终批准 Bash（仅跳过默认审批）
使用 ↑/↓ 或数字键选择，回车确认，Esc 拒绝本次。

→ 已在本会话始终批准 Bash

● Bash(printf hello > manual-first.txt) · 运行中
● Bash(printf hello > manual-first.txt) · 成功

[人工审批] Bash 已在本会话获准，跳过默认审批。

● Bash(printf world > manual-second.txt) · 运行中
● Bash(printf world > manual-second.txt) · 成功

[人工审批 2] write_file（调用 manual-write；最多等待 20000ms）
{
  "path": "manual-note.txt",
  "content": "manual-content"
}
实际文件目标：…/.scratch/issue-156/manual-workspace-4/manual-note.txt
❯ 1. 批准本次
  2. 拒绝本次
  3. 本会话始终批准 write_file（仅跳过默认审批）
使用 ↑/↓ 或数字键选择，回车确认，Esc 拒绝本次。
1❯ 1. 批准本次
  2. 拒绝本次
  3. 本会话始终批准 write_file（仅跳过默认审批）
使用 ↑/↓ 或数字键选择，回车确认，Esc 拒绝本次。

→ 已批准本次

● write_file(manual-note.txt) · 运行中
● write_file(manual-note.txt) · 成功
终端验收完成：两步命令已执行，写文件已批准。
> /exit
```

结果核对：

- 第一次 Bash 通过菜单选择“本会话始终批准 Bash”，命令执行并写出 `manual-first.txt`。
- 第二次 Bash 属于同一工具的默认审批，没有再次显示菜单，直接执行并写出 `manual-second.txt`；记录中出现“已在本会话获准，跳过默认审批”。
- `write_file` 没有被会话批准扩展覆盖，仍显示 `[人工审批 2]` 并展示完整参数；选择批准后写出 `manual-note.txt`。
- 工具输出为 `工具名(参数摘要) · 状态`，同一屏幕行原地更新，没有开始/结束各占一行并连续向下堆叠。

原始捕获（含 ANSI 控制符）保留在本地 `/tmp/manual-qa-156-3.txt`，不提交。