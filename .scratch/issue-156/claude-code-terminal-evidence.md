# Issue #156 本机 Claude Code 终端交互调研

调研环境：macOS arm64，`claude` 2.1.325（`/opt/homebrew/bin/claude` → `@anthropic-ai/claude-code/bin/claude.exe`）。
目标 SHA-256：`84590fefe6338be9087f5814b61f9a54c5f21524163a4c127cb5a808e31009f2`。

## REA 静态检查

- `open_binary` 识别为 `mach-o` / bun-standalone，模块布局 `bun-1.3.9`。
- `inspect_artifact`（证据 `ev_960456dfece0ab8ffce65d3eb6fb20250482547ab6b61d27a822aa8fc28bcd93`）显示 3312 个打包模块、6364 个容器条目；入口模块 `$bunfs/root/cli`。静态检查只证明发布物内容，不证明运行行为。
- 对发布物字符串取证（非执行）发现：
  - 审批选项按工具/规则动态生成，包含 `Yes, allow reading from … from this project`、`Yes, and always allow access to …`、`Yes, and don't ask again for … commands`、`No, and tell Claude what to do differently (esc)`。
  - 审批选项内部值包含 `yes-dont-ask-again`，说明“以后不再问”是独立选项，不是文本命令。
  - 工具思考/输出默认折叠，提示 `(ctrl+o to expand)`；`ctrl+o` 进入 transcript 查看。
  - 另见会话级选项 `Yes, for this session` / `Yes, and remember this directory`，说明 Claude Code 区分“本次 / 本会话 / 持久项目规则”。

## REA 运行时捕获

使用 `capture_process_scenario` 在仓库内 `.scratch/issue-156/pty-sandbox` 启动真实 `claude`，参数：
`--safe-mode --permission-mode manual --ax-screen-reader`。以下均为终端实际输出，不是推测。

### 捕获 1：安全命令的工具呈现

证据 `ev_fe114ff3ba9740edfa4ce791adb248b35ca841fa83d9fafdfac482339f3efff6`。
实际帧（节选）：

```
tool: Thinking for 2s… (ctrl+o to expand)
Thought for 2s (ctrl+o to expand)
tool: Bash (echo hello-156)
Running…
hello-156
claude: hello-156
```

观察：
- 工具调用只占一行：`tool: Bash (echo hello-156)`，参数压缩为单行摘要。
- 思考内容默认折叠，仅显示耗时和 `(ctrl+o to expand)`。
- 工具结果紧凑地跟在工具行后，完成后只保留一行最终摘要，不会开始/结束各占一行并反复堆叠。

### 捕获 2：审批提示（等待中）

证据 `ev_0ceda4bce2abcd8124e6d6bf4ff727ba9f0735e586eb2ae9f0adb04f2b4e6ccc`。
实际帧（节选，屏幕阅读器模式把 TUI 压平为文本）：

```
tool: Bash (touch approval-156.txt)
Waiting…
Permission Required: Bash command
Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
> Create empty file approval-156.txt
> touch approval-156.txt
Do you want to proceed?
1. Yes
2. Yes, and always allow access to …/.scratch/issue-156/pty-sandbox from this project
3. Yes, and switch to auto mode — auto mode handles these prompts for you
4. No
Select with numbers [1-4]. Then Enter to submit or Escape to cancel:
Esc to cancel
```

观察：
- 审批展示工具名称、完整命令和后果说明，不需要输入 `approve` 编号。
- 选项包括“本次批准”“以后始终允许该范围/命令”“切换自动模式”“拒绝”，用数字或方向键选择。
- 无交互终端时 Claude Code 有单独的非交互审批通道；本次改造保留现有文本审批协议。

### 捕获 3：拒绝本次

证据 `ev_6034f2c918ebefee65685ac1defc3ae94861dc5607ce9e47f550f994201a2b8f`。
发送 `4` + Enter 后实际帧：

```
tool error: Bash (touch approval-156.txt)
Interrupted · What should Claude do instead?
```

沙箱目录中没有生成 `approval-156.txt`，说明拒绝在启动命令前生效。

## 对本次实现的取舍

1. 工具输出：交互终端按“模型步”聚合为紧凑块；每个调用一行 `工具名(参数摘要) · 状态`，运行中原地刷新，步结束后保留最终状态。普通输出不打印文件内容或完整 JSON，完整参数仍在审批界面展示；非交互管道继续输出原有逐行事件，便于日志和现有测试。
2. 审批：交互终端改用键盘菜单（数字或 ↑/↓ 选择，回车确认，Esc 拒绝），默认不自动确认，避免把后续用户输入误当批准。选项为“批准本次 / 拒绝本次 / 本会话始终批准当前工具类型”。
3. 会话批准：内存集合，按工具名区分；只在审批由工具默认行为触发时跳过，显式 `ask`/`deny` 规则仍在审批前生效；进程退出即失效。非交互输入保留 `approve N` / `deny N` 文本协议。