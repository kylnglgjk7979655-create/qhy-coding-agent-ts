# Hook v1 只开放六个生命周期事件，命令经信任门禁后执行

父需求 #151 的子任务 #158–#173 增加 Hook 子系统。本决策记录 v1 的事件集取舍、协议版本、与 Claude Code 的偏离、安全模型、并发与超时及 deadline 语义、输出上限、注入时序和 Stop 续跑边界。本文只记录已实现的行为，不改变运行时代码或测试。

> 编号说明：父需求原计划使用 ADR 0005，但 0005 已由父需求 #136 的 [Bash 沙箱](0005-bash-sandbox.md) 使用；之后 0006 又由父需求 #152 的 [Claude 风格工具与网络访问](0006-claude-style-tools-and-network-access.md) 使用。为避免重号，本决策在合并 main 后落为 0007。

## 事件集与触发范围

v1 只实现六个生命周期事件，配置中的其他事件键在加载阶段以 `CONFIG_ERROR` 拒绝：

| 事件 | 触发时机 | matcher 查询字段 |
| --- | --- | --- |
| `SessionStart` | 新建对话或恢复既有对话时，在任何用户提交之前 | `source`（`startup` / `resume`） |
| `UserPromptSubmit` | 真实用户提交消息之后、第一轮模型请求之前 | 无 |
| `PreToolUse` | 工具 `prepare` 与既有转录通知之后、权限策略与审批之前 | `tool_name` |
| `PostToolUse` | 工具执行成功之后 | `tool_name` |
| `PostToolUseFailure` | 工具执行抛错之后 | `tool_name` |
| `Stop` | 最终回答产生之后、轮次结束之前 | 无 |

`SessionEnd`、`StopFailure`、`SubagentStart`、`SubagentStop`、`Notification`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied` 和 `Setup` 不进入 v1。异步或后台 Hook、`asyncRewake`、首行 `{"async":true}` 协议，以及 `prompt`、`agent`、`http` 类型同样未实现；v1 只有同步 `command` 类型。这样做的原因是先固定一条可审计的“stdin JSON + stdout JSON + 退出码”契约，并让所有 Hook 都能在轮次结束前确定结果。

`SessionStart` 只接受 `startup` 与 `resume` 两种来源。新进程新建对话和 `/clear` 使用 `startup`；启动时恢复既有会话和在进程内 `/resume` 使用 `resume`。其他来源名在配置校验或输入类型处不可达。

事件范围还受运行场景约束：

- `--smoke-tool` 探针轮次仍按普通配置加载规则解析 settings，但不运行信任门禁、不执行任何 Hook、不注入上下文，避免模型兼容性检查受用户扩展干扰。
- 后台任务通知形成的轮次不触发 `SessionStart` 与 `UserPromptSubmit`，因为通知不是用户提交；工具事件按该轮实际工具调用照常触发，该轮次也触发 `Stop`，与普通轮次共用结束检查和续跑边界。
- 子 Agent 只触发工具类事件，即 `PreToolUse`、`PostToolUse` 和 `PostToolUseFailure`；不触发 `SessionStart`、`UserPromptSubmit` 与 `Stop`，避免同一对话重复注入上下文或重复结束检查。

子 Agent 的工具事件沿用父对话的 `session_id` 和 `transcript_path`，并附加 `agent_id` 与 `agent_type`。主 Agent 的工具事件不写这两个字段。`agent_id` 使用本次委派工具调用 ID；前台 general-purpose、后台 general-purpose 与 Explore 使用同一约定。本仓库不持久化子 Agent 独立会话，构造独立标识会发明不存在的东西，因此这里刻意偏离 Claude Code 常见做法。

## 配置载体、分层合并与信任门禁

Hook 配置位于现有三层 settings 的顶层 `hooks`：

```text
~/.agent/settings.json                         用户级
<workspace>/.agent/settings.json               项目级
<workspace>/.agent/settings.local.json         项目本地
```

旧版 `agent.config.json` 只产生迁移提示，不参与加载；项目级和项目本地 settings 不能设置 `workspace`。配置形状为“事件名 → matcher 组数组 → Hook 数组”：

```text
hooks?: {
  SessionStart?:       Array<{ matcher?: string; hooks: HookCommand[] }>
  UserPromptSubmit?:   Array<{ matcher?: string; hooks: HookCommand[] }>
  PreToolUse?:         Array<{ matcher?: string; hooks: HookCommand[] }>
  PostToolUse?:        Array<{ matcher?: string; hooks: HookCommand[] }>
  PostToolUseFailure?: Array<{ matcher?: string; hooks: HookCommand[] }>
  Stop?:               Array<{ matcher?: string; hooks: HookCommand[] }>
}

HookCommand = {
  type: 'command'
  command: string
  timeoutMs?: number
}
```

`type` 必填且只接受 `command`；`command` 去除首尾空白后必须非空；`timeoutMs` 必须是整数且位于 `1..600000`。`matcher` 省略、空字符串和 `*` 都表示匹配全部。未知事件键、未知 Hook 组字段、空 `hooks` 数组、未知类型、越界超时和非法 matcher 正则都在配置加载阶段以 `CONFIG_ERROR` 拒绝，不会留下“看起来配置了但永远不匹配”的静默状态。

三层合并与普通对象覆盖不同：`hooks` 按事件拼接数组，顺序固定为用户级 → 项目级 → 项目本地。拼接后按“事件 + matcher + command + timeoutMs”完全相同的 Hook 去重，保留配置顺序中的第一条并输出 warning；一个组内的 Hook 全部被去掉时整组移除。合并结果还会再走一次同一去重路径，因此单层 settings 内的完全重复项也被去除。项目层不能借覆盖移除上层 Hook，也不能改变“保留第一条”的语义。这个策略与 Claude Code 的宽去重、保留最后一条不同，见后文偏离表。

顶层 `disableAllHooks` 默认 `false`，CLI 另有 `--no-hooks`。禁用优先于信任：命中禁用时不加载、不提示、不执行任何 Hook。启用时，只有在存在实际 Hook 命令（任一事件下至少一个带 Hook 的组）时才进入信任门禁。

信任门禁在任何 Hook 执行之前运行：

1. 工作区 realpath 与规范化 hooks 配置 hash 同时匹配用户目录的 `~/.qhy-coding-agents/trusted.json` 时，视为已信任。
2. 否则，`--trust-hooks` 或 `QHY_TRUST_HOOKS=1` 是显式 opt-in：写入当前 hash 后启用。
3. 否则，交互终端展示完整命令清单（事件、matcher、命令和可选 `timeoutMs`）并要求确认；拒绝后禁用全部 Hook。
4. 否则，非交互终端（stdin 或 stdout 不是 TTY）打印禁用警告并禁用全部 Hook，普通对话继续。仓库不能给自己授权。

信任记录只保留在 CLI 用户目录，工作区内的同名文件永远不会被读取。hash 只覆盖规范化后的 `hooks` 配置：对象键排序、剔除 `undefined`、数组保持配置顺序；修改模型、权限等无关 settings 不会触发重新确认，修改事件、matcher、命令或 `timeoutMs` 会。记录文件要求常规文件、非符号链接、权限不宽于 `0600`，目录 `0700`，写入采用临时文件加 `rename`；读取失败、记录损坏或权限过宽一律按未信任处理。写入失败只警告，不阻断本次已确认的运行，下次启动重新确认。

Hook 配置和 `disableAllHooks` 不写入会话持久化，也不进入 `loggableConfig`，避免命令或命令中的凭据落入磁盘和日志。恢复对话（包括启动时 `--conversation-id` 和进程内 `/resume`）时，从磁盘当前 settings 重新加载 Hook 配置并重新执行信任门禁；旧会话快照中的 `hooks` 与 `disableAllHooks` 直接忽略。

## matcher 与 stdin 契约

matcher 不是 glob，按以下顺序解析：

- 省略、空字符串或 `*`：匹配全部。
- 完全由 `A-Za-z0-9_` 组成的字符串：精确名称。
- 由 `|` 分隔且每段都是精确名称的字符串：名称列表，例如 `Bash|Read`。
- 其他字符串：按 JavaScript 正则解析并在加载阶段试编译，例如 `^mcp_`；非法正则直接拒绝。

没有 matcher 查询字段的事件不做过滤，即使写了 matcher 也会运行所有 Hook。查询字段是：`SessionStart` 用 `source`，三个工具事件用 `tool_name`，`UserPromptSubmit` 与 `Stop` 没有查询字段。

所有 Hook 从 stdin 收到恰好一个 JSON 对象。基础字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `session_id` | string | 对话标识；子 Agent 工具事件使用父对话标识 |
| `transcript_path` | string | 会话记录路径；子 Agent 指向父对话记录 |
| `cwd` | string | 工作区绝对路径，同时是 Hook 进程的工作目录 |
| `approval_mode` | `'model' \| 'human'` | 由 `approval.mode` 映射：`auto` → `model`，`default` → `human` |
| `hook_event_name` | 事件名 | 当前事件字面量 |
| `agent_id` | string，可选 | 仅子 Agent 工具事件 |
| `agent_type` | string，可选 | 仅子 Agent 工具事件 |

`approval_mode` 不沿用 Claude Code 的 `permission_mode`。本仓库的审批模式只有 `default`（人工）与 `auto`（模型），三态或多态权限模式无法无歧义映射，因此使用两值字段。`hook_event_name` 是相对早期 QA 清单的补充；它使同一个命令可以安全地挂在多个事件下，不必靠事件专有字段推断。

事件专有字段：

| 事件 | 额外字段 |
| --- | --- |
| `UserPromptSubmit` | `prompt`：真实用户提交的原始文本 |
| `PreToolUse` | `tool_name`、`tool_input`（`prepare` 后、即将审批和执行的输入）、`tool_use_id` |
| `PostToolUse` | `tool_name`、`tool_input`、`tool_response`（`{ is_error: false, output }`，与返回给模型的成功信封一致）、`tool_use_id` |
| `PostToolUseFailure` | `tool_name`、`tool_input`、`error`（字符串）、`error_code`（工具错误码枚举）、`tool_use_id` |
| `Stop` | `stop_hook_active`、`last_assistant_message` |
| `SessionStart` | `source`（`startup` / `resume`） |

`tool_input` 不是模型原始输入，而是工具 `prepare` 之后的输入；例如文件工具带解析后的目标路径，Bash 带实际命令、工作目录和沙箱计划。`tool_use_id` 与本次工具调用 ID 相同，用于关联同一调用的三个工具事件。`PostToolUseFailure` 的 `error_code` 只取 `INVALID_TOOL_ARGUMENTS`、`UNKNOWN_TOOL`、`TOOL_EXECUTION_ERROR`、`PERMISSION_DENIED` 之一；当前该事件通常只看到 `TOOL_EXECUTION_ERROR`，因为参数错误、未知工具和权限拒绝不触发它，保留完整枚举是为了契约稳定。

协议版本由代码常量 `HOOK_PROTOCOL_VERSION = 1` 表示，不写入 stdin JSON，避免每个 Hook 都必须解析版本。以后增加事件或字段时必须提升该常量，并在 ADR 记录兼容边界。

Hook 通过 `/bin/sh -c <command>` 在独立进程组中启动，工作目录固定为 `cwd`，继承 CLI 进程环境；v1 没有 per-hook 环境变量、Windows/powershell 或 `if` 输入级过滤。Hook 自己读取 stdin 决定是否处理。

## 退出码与 stdout 契约

| 退出码 | 含义 | 结果 |
| --- | --- | --- |
| `0` | 成功 | 解析 stdout：以 `{` 开头按 JSON，否则按普通 stdout |
| `2` | 阻止 | `outcome: blocking`，理由取 stderr；空时使用默认文案 |
| 其他非零 | Hook 故障 | `outcome: non_blocking_error`，`failureKind: exit_code`，只提示不阻止 |
| 超时 | 执行边界 | `non_blocking_error` + `timeout` |
| 启动失败 | 执行边界 | `non_blocking_error` + `spawn_error` |
| 输出超限 | 执行边界 | `non_blocking_error` + `output_limit` |
| 调用方取消 | 用户中断 | `outcome: cancelled`，与 Hook 自身故障区分 |

stdout 期望恰好一个 JSON 对象；日志、警告和调试信息写 stderr。去除首尾空白后以 `{` 开头但 JSON 无效，或已知字段类型不符时，按 `non_blocking_error` + `invalid_json` 处理，不静默忽略。未知 JSON 字段忽略。退出码 `2` 时只读取 stderr 作为理由，不解析 stdout。

v1 支持的 stdout JSON 字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `continue` | boolean | `UserPromptSubmit` 为 `false` 时保留原 prompt 但停止本轮；`Stop` 为 `false` 时禁止续跑 |
| `preventContinuation` | boolean | 仅 `Stop`：禁止随后的自动续跑 |
| `suppressOutput` | boolean | 隐藏普通 stdout 的用户提示与日志展示，不改变 JSON 处理和模型注入 |
| `decision` | `'block'` | 按事件表示阻止 |
| `reason` | string | 阻止或停止理由 |
| `systemMessage` | string | 只给用户看的提示，不进入模型上下文 |
| `hookSpecificOutput.permissionDecision` | `'allow' \| 'deny' \| 'ask'` | 仅 `PreToolUse` 的权限结论 |
| `hookSpecificOutput.permissionDecisionReason` | string | 权限结论说明，用于审批展示 |
| `hookSpecificOutput.updatedInput` | object | 仅 `PreToolUse` 的工具参数改写候选 |
| `hookSpecificOutput.additionalContext` | string | 附加上下文或工具反馈 |

`decision: 'block'` 因事件而异：

- `PreToolUse`：等价于 `deny`。
- `UserPromptSubmit`：取消本轮，不发出模型请求，不保留原 prompt。
- `PostToolUse` / `PostToolUseFailure`：只作为反馈，不撤销副作用、不改变工具结果。
- `Stop`：请求一次续跑。

普通 stdout 的归属也按事件区分：只有 `SessionStart` 与 `UserPromptSubmit` 的 exit 0 非 JSON stdout 会作为附加上下文进入模型；其他事件的普通 stdout 只进入用户提示或日志。`suppressOutput` 只隐藏展示，不改变 `SessionStart` / `UserPromptSubmit` 的注入。`systemMessage` 始终只给用户，不进入模型。`additionalContext` 在被使用时只进入模型，不出现在用户提示中；`PreToolUse` 的例外见下文。

`PreToolUse` 的 `additionalContext` 在 v1 不注入模型；需要说明时使用 `permissionDecisionReason`（审批展示）或 `systemMessage`（用户提示）。`updatedMCPToolOutput` 与远程 MCP 工具结果改写不在 v1。

### PreToolUse 的结论聚合

多个 `PreToolUse` Hook 的权限结论按 `deny > ask > allow` 聚合，同优先级取配置顺序中的第一条。`exit 2` 与 `decision: 'block'` 都等价于 `deny`。`deny` 在审批前短路，返回原有的 `PERMISSION_DENIED` 工具结果，不执行工具，也不影响同批其他调用。

`allow` 不是通行证：它仍须经过 settings 规则匹配，`deny` 规则继续优先，`ask` 规则仍触发模型或人工审批；只有规则本身没有 `deny` / `ask` 时才跳过默认审批。`ask` 即使规则原本 `allow` 也强制审批，`permissionDecisionReason` 作为审批说明。Hook 故障、超时和不带权限结论的成功输出不参与聚合，也不改变工具本身的结果。

`updatedInput` 先经该工具注册时的 `inputSchema` 校验。校验失败的运行记为 `non_blocking_error` + `invalid_updated_input`，忽略该 Hook 的权限结论，回退原输入继续正常审批；不会因为 Hook 改写而放行非法参数。多个有效改写按配置顺序覆盖，最后一个用于审批展示和实际执行；`prepare` 会基于改写输入重新生成审批细节和执行参数，准备失败则回退原输入。`deny` 优先于任何改写，改写结果不会交给审批或执行。

### 工具事件与会话事件的结论

`PostToolUse` 只在执行成功后运行，`PostToolUseFailure` 只在执行抛错后运行；参数错误、未知工具和权限拒绝不触发后者。两者都以反馈形式消费阻止理由与 `additionalContext`，不改变已经返回的工具结果或错误码。`SessionStart` 的 exit 2 理由按附加上下文注入，阻止启动不是 v1 语义；`UserPromptSubmit` 的 exit 2 与 `decision: 'block'` 取消本轮，`continue:false` 保留原 prompt 但停止后续处理。`Stop` 的阻止与续跑规则见后文。

## 并发、超时与 deadline 语义

同一事件匹配到的所有 Hook 并行启动，并等待全部完成；结果与注入消息按配置顺序稳定排列。整批 Hook 的延迟是最慢 Hook 的耗时，不是全部 Hook 之和。同一事件内不再设额外并发上限，实际并发由配置的 Hook 数量决定。

每个 Hook 使用独立的 `AbortController` 与调用方取消信号组合，并有独立超时。未显式配置 `timeoutMs` 时按事件取默认值：

| 事件 | 默认超时 |
| --- | --- |
| `SessionStart` | 60,000 ms |
| `UserPromptSubmit` | 10,000 ms |
| `PreToolUse` | 60,000 ms |
| `PostToolUse` | 60,000 ms |
| `PostToolUseFailure` | 60,000 ms |
| `Stop` | 60,000 ms |

单个 Hook 可用 `timeoutMs` 覆盖，统一上限 600,000 ms。任一 Hook 的超时、故障或输出超限只影响自身，其他 Hook 和工具继续。用户取消会中止所有正在运行的 Hook，每个结果标记为 `cancelled`。

超时或取消时向整个进程组发送 `SIGKILL`，包含孙进程。直接子进程退出后，运行器立即回收残留进程组，并在短暂宽限后销毁 stdout/stderr，避免后台孙进程继承管道使调用方一直等到超时；CLI 主进程退出时也统一清理仍在跟踪的进程组。stdin 写入遇到 `EPIPE` 时，如果 Hook 仍产出了输出或明确退出码，不升级为故障；只有退出 0 且完全无输出时才按 `spawn_error` 处理，避免把正常的“不读 stdin”脚本判为失败。

deadline 语义如下：

- `PreToolUse`、`PostToolUse`、`PostToolUseFailure` 在 `runAgent` 的整轮时限内执行。Hook 运行期间暂停该轮剩余时限，结束后恢复；多个工具 Hook 并发时使用可重入的暂停计数，全部结束后才恢复计时。因此慢 Hook 不会被对话超时误杀，也不会把 Hook 耗时重复计入模型执行预算。
- `SessionStart`、`UserPromptSubmit` 和 `Stop` 在 `runAgent` 之外执行，由各自的 `timeoutMs` 与轮次取消信号约束。它们不暂停一个当时并不存在的 `runAgent` deadline，也不重置或延长随后模型请求的预算。
- 所有 Hook 共用的取消来源是当前轮次信号；用户中断、整轮取消或 CLI 终止会传播到所有正在运行的 Hook。`Stop` 在最终回答之后、Hook 启动之前的取消属于取消路径，不运行 Stop。

## 输出上限与可观测性

捕获层和注入层都有硬上限：

| 常量 | 值 | 行为 |
| --- | --- | --- |
| `MAX_HOOK_STDOUT_BYTES` | 1 MiB | 立即终止该 Hook 的进程组；结果 `non_blocking_error` + `output_limit`；只提示不阻止 |
| `MAX_HOOK_STDERR_BYTES` | 64 KiB | 保留前 64 KiB，追加 `[hook stderr 已截断]`，继续消费并丢弃剩余内容，不终止进程 |
| `MAX_HOOK_INJECT_CHARS` | 8,000 个 Unicode 字符 | 所有进入模型的文本统一截断并附加省略标记；标记本身不占用上限 |
| `MAX_HOOK_UI_LINE_CHARS` | 500 个字符 | 用户可见 `[hook]` 行截断并加省略号 |

stdout 超限是故障，不是阻止；stderr 超限只影响诊断文本。`stdoutIsJson` 只在成功解析 JSON 对象时为真；成功 JSON 的普通 stdout 不再重复作为普通文本注入。

Hook 观测使用独立回调，不与工具执行事件混用：

- `started` 在进程启动前发出；成功、阻止和取消以 `finished` 结束，`non_blocking_error` 以 `failed` 结束。
- Hook 标识为 `事件:配置顺序`，例如 `PreToolUse:0`，同一事件内稳定。
- 结构化日志只记录 `hookEvent`、`hook`、`durationMs`、`exitCode`、`outcome`、可选 `failureKind`、`stdoutBytes` 和 `stderrBytes`；不打印完整 stdin、工具参数、stdout 或 stderr。
- 只有显式 `QHY_HOOK_DEBUG=1` 才在日志中追加完整 stdout/stderr；`suppressOutput: true` 时仍隐藏 stdout。
- 观测回调抛错或异步拒绝只写 stderr，不改变 Hook 结果、工具结果或模型流程。

用户提示走 stderr，形如 `[hook] <event>: <reason>`；阻止、`continue:false`、`systemMessage`、普通 stdout 和 Hook 故障都有各自措辞。用户中断显示“已取消（用户中断）”，与“Hook 故障：执行超时/退出码…”区分责任方。

## 注入时序与受众

所有 Hook 注入都是独立的隐藏 `user` 消息，不折入工具结果，不改变工具调用与工具结果的配对：

- 上下文类：`<hook-context event="SessionStart">…</hook-context>` 或 `<hook-context event="UserPromptSubmit">…</hook-context>`。
- 反馈类：`<hook-feedback event="PostToolUse" hook="PostToolUse:0">…</hook-feedback>`；`PostToolUseFailure` 与 `Stop` 使用对应事件名和配置顺序。

| 事件 | 注入内容 | 位置 | 何时可见 |
| --- | --- | --- | --- |
| `SessionStart(startup)` | 成功运行的 `additionalContext` 或普通 stdout；exit 2 的 stderr 理由 | 新建对话历史首部，第一轮用户消息之前 | 第一次模型请求，并随成功轮次持久化 |
| `SessionStart(resume)` | 同上 | 重建历史尾部，下一条用户消息之前 | 恢复后的下一次模型请求，并随成功轮次持久化 |
| `UserPromptSubmit` | 成功运行的 `additionalContext` 或普通 stdout | 用户消息之后、第一次模型请求之前 | 本轮第一次模型请求，并随成功轮次持久化 |
| `PreToolUse` | 不注入模型上下文 | 无 | 无 |
| `PostToolUse` / `PostToolUseFailure` | exit 2 / `decision: block` 的理由与成功的 `additionalContext` | 整批工具结果之后的隐藏用户消息 | 同轮下一次主模型请求，并随成功轮次持久化 |
| `Stop` | exit 2 / `decision: block` 的理由 | 最终回答之后、续跑请求之前 | 续跑请求；第二次 Stop 的反馈丢弃 |

`SessionStart` 没有可阻止的启动动作：exit 2 的理由按附加上下文注入，启动继续。`UserPromptSubmit` 的 exit 2 或 `decision: block` 取消本轮，不发出模型请求也不保留原 prompt；`continue:false` 保留原 prompt 并停止后续处理，理由只给用户看。`PostToolUse` 与 `PostToolUseFailure` 的 block 只追加反馈，工具结果、错误码和已发生的文件/宿主/远端副作用都保持不变。`Stop` 的理由只通过续跑请求进入模型。

工具反馈在工具回调中按 `tool_use_id` 暂存，到 `prepareStep` 才消费。注入消息排在本次步骤全部工具结果之后；同一批多个工具调用按工具结果在消息中的顺序排列，同一事件内多个 Hook 按配置顺序排列。找不到对应工具结果的暂存项仍按暂存顺序追加，避免反馈丢失。

注入去重使用每个 CLI 进程一个 `Set<string>`，键是每次 Hook 运行的随机标识；`prepareStep` 检查后注入并登记，不扫描命令输出，因为输出可能恰好包含运行标识。该集合由当前会话和子 Agent 共享，但不跨进程持久化，因此不提供跨进程去重。

Hook 结果不会插入正在进行的模型请求：工具事件反馈只能在下一次主模型请求可见，`Stop` 反馈只能在续跑请求可见。注入消息进入有效历史并随成功轮次持久化，因此后续轮次仍可见；失败或取消时按既有轮次语义处理。

## Stop 续跑边界

`Stop` 在第一次 `runAgent` 成功返回之后、`finishSessionRound` 之前运行。它不接收 matcher 过滤，默认超时 60 秒。用户取消、整轮超时、模型异常终止、步数上限或没有完整回答的失败路径不触发 `Stop`。

续跑规则：

1. `exit 2` 或 `decision: 'block'` 在第一次运行请求续跑。
2. 任一成功 Hook 返回 `continue:false` 或 `preventContinuation:true` 时直接结束本轮，不再续跑；`continue:false` 与 `preventContinuation` 优先于其他 Hook 的阻止，其理由只给用户看，不注入有效历史。
3. 没有阻止结论、只有 Hook 故障或超时时不续跑。
4. 续跑最多一次，且仍在同一个 round ID 内；第二次 `Stop` 的 `stop_hook_active` 为 `true`，即使再次返回 block 也只记录日志，不续跑、不注入新反馈。
5. 续跑不新增用户 prompt，只以第一次运行的有效历史和 Stop 反馈发起请求。
6. 续跑使用本轮剩余步数：`config.maxSteps` 减去第一次运行已用步数；剩余步数不大于 0 时不续跑，并在 stderr 说明。这样一次 `Stop` 不会让整轮获得两倍步数。
7. 两次运行的 `roundMessages`、摘要、Skill 加载与统计合并；最终回答以续跑结果为准，最终有效历史包含 Stop 反馈。第一次运行已经写入的压缩检查点仍可恢复，续跑从磁盘读取最新摘要边界与 Skill 状态。
8. 第一次 `Stop` 的 `stop_hook_active` 为 `false`，`last_assistant_message` 对应第一次回答；续跑结束后的第二次 `Stop` 输入 `stop_hook_active: true` 且 `last_assistant_message` 对应续跑回答。取消或异常终止不补造第二次运行。

后台任务通知轮次也运行 `Stop`，其续跑边界与普通轮次相同；smoke 轮次不运行。

## 安全模型

Hook 是用户配置的任意 shell 命令，等价于以当前用户权限执行远程代码。信任门禁只解决“仓库不能静默让其命令执行”，不是操作系统沙箱，也不是权限审批的替代品。

- Hook 以 CLI 当前用户权限运行，继承完整 CLI 环境变量，工作目录固定为工作区，但可以访问工作区外的文件系统和网络；`permissions` 与工具审批不约束 Hook 命令。
- v1 没有 per-hook 环境变量、操作系统沙箱或 seccomp；需要隔离时应在 CLI 外自行包装。
- 信任门禁在首次遇到未信任配置时展示完整命令清单并要求交互确认；非 TTY 未信任默认禁用，`--trust-hooks` / `QHY_TRUST_HOOKS=1` 才是显式授权。`disableAllHooks` 与 `--no-hooks` 优先于信任判断。
- 信任记录只放用户目录，工作区文件不能自我授权；记录权限过宽、损坏、符号链接或非普通文件都按未信任处理。信任 hash 只覆盖 Hook 配置，修改命令、matcher 或超时必须重新确认。
- 信任记录本身没有签名，能修改当前用户目录的进程仍可改写记录；它防止的是仓库内容而非已取得当前用户权限的攻击者。
- Hook 配置不写入会话记录或普通日志；但 Hook 自身打印到 stderr 的内容、Hook 读取的 stdin 和文件内容仍由 Hook 控制。默认结构化日志不包含正文，`QHY_HOOK_DEBUG=1` 会显式打开正文日志。
- Hook 故障不会新增顶层 `AgentError` 错误码。超时、启动失败、无效 JSON、输出超限和非零退出都转为 `non_blocking_error`；用户取消转为 `cancelled`。工具本身仍按原有错误码返回，避免把“Hook 坏了”误报成“工具失败”。

## 与 Claude Code 的偏离

下表以本仓库实现时对照的 Claude Code 公开 hooks 契约为参照，不承诺与任何具体版本逐字段兼容。标为“对齐”的项目是刻意保持相同语义；“偏离”是 qhy 的 v1 取舍。

| 主题 | Claude Code 常见契约 | 本仓库 v1 |
| --- | --- | --- |
| 事件集 | 还覆盖 `SessionEnd`、`Notification`、`PreCompact`、`SubagentStart`、`SubagentStop`、`StopFailure`、`PermissionRequest` 等 | 只开放六个事件；`SessionStart` 只支持 `startup` / `resume`；smoke 不触发；后台通知轮次只触发 `Stop` |
| 配置载体 | `.claude/settings.json`、`.claude/settings.local.json` 及用户级同类 | 用户级 `~/.agent/settings.json`、项目级 `<workspace>/.agent/settings.json`、项目本地 `.agent/settings.local.json`；旧 `agent.config.json` 只提示迁移，不加载 |
| 三层合并与去重 | 常用宽去重并保留最后一条 | 按事件拼接用户级 → 项目级 → 项目本地；按事件 + matcher + command + timeoutMs 完全相同的 Hook 去重，保留第一条并输出 warning；同一层内重复项也去除 |
| `approval_mode` | 使用 `permission_mode` 表示多态权限模式 | 只传 `approval_mode: 'model' \| 'human'`，由 `approval.mode` 的 `auto` / `default` 映射；不提供 `permission_mode` |
| 子 Agent 的 `session_id` 与记录路径 | 子 Agent 可有独立会话或独立 transcript | 工具事件沿用父 `session_id` 和父 JSON 会话记录路径，附加 `agent_id` / `agent_type`；不持久化子 Agent 独立会话；子 Agent 不触发会话级事件 |
| `hook_event_name` | 每个事件的 stdin 都带事件名字面量 | 对齐：每个 stdin 都带 `hook_event_name`；这是相对早期 QA 清单的补充，使同一命令可安全挂在多个事件下 |
| matcher | 常见 glob 或正则语义 | 非 glob：精确名、`A\|B` 名称列表、JS 正则、空串/`*`；`UserPromptSubmit` 与 `Stop` 没有查询字段，matcher 不生效 |
| 配置校验 | 宽松接受未知字段 | fail-fast：未知事件/类型/组字段、空 command、空 hooks 数组、超时越界、非法 matcher 正则都在加载阶段 `CONFIG_ERROR` |
| `tool_input` | 通常为工具调用原始参数 | 使用 `prepare` 后、即将审批和执行的输入；`tool_use_id` 关联同一调用的三个工具事件 |
| 协议版本 | 可能随事件类型变化或带版本字段 | `HOOK_PROTOCOL_VERSION = 1` 是代码常量，不写入 stdin；未知 stdout 字段忽略，已知字段类型不符按 `invalid_json` 处理 |
| `transcript_path` | 指向 JSONL transcript | 指向本仓库的 JSON 会话记录；子 Agent 指向父对话记录 |
| 输出上限 | 没有与 qhy 相同的固定上限 | stdout 1 MiB 超限终止进程组；stderr 64 KiB 截断并标记；模型注入 8,000 字符；用户 UI 行 500 字符 |
| 普通 stdout | 不同事件的归属规则不同 | 只有 `SessionStart` / `UserPromptSubmit` 的成功普通 stdout 注入模型；其他事件只进用户提示/日志 |
| PreToolUse 附加上下文 | 可提供模型上下文 | v1 不注入；理由用 `permissionDecisionReason` 给审批、`systemMessage` 给用户 |
| 副作用与改写 | 支持更多工具结果改写 | `PostToolUse` / `PostToolUseFailure` 的 block 只反馈，不撤销副作用；不实现 `updatedMCPToolOutput` |
| Stop 续跑 | 可有不同的续跑与循环边界 | 最多续跑一次；第二次 block 只记录；使用剩余 `maxSteps`；`continue:false` / `preventContinuation` 直接结束 |
| 信任模型 | 由宿主环境提供的信任/权限机制 | qhy 自有工作区 realpath + hooks 配置 hash 信任记录；非 TTY 未信任 fail-closed；工作区内的信任文件无效 |
| Hook 类型 | 支持 command 等更多类型 | 只支持同步 `command`；async/background、`prompt`、`agent`、`http`、`if` 和 per-hook 环境变量均未实现 |

## 版本与后续演进

`HOOK_PROTOCOL_VERSION = 1` 定义 v1 契约：六个事件、command 类型、stdin 基础字段、退出码、stdout JSON 字段、八千字符注入上限和一次 Stop 续跑。v1 不为异步 Hook 预留运行中状态；runner 的稳定接口是“Hook 定义 + stdin 输入 + `{ cwd, env?, signal?, timeoutMs? }` → `HookResult`”，以后增加后台注册表不应改变调用方的事件接线。

以下项目明确不在 v1：async/background Hook、`asyncRewake`、首行 async JSON、prompt/agent/http 类型、`if` 输入级过滤、`SessionEnd` 等未列事件、`updatedMCPToolOutput`、Windows/powershell Hook、per-hook 环境变量、Hook 市场/UI/模板、跨进程注入去重、Hook 的操作系统沙箱、YAML/TOML 配置，以及把 Hook 进度伪装成工具结果或执行事件。

相关决策：工具策略与审批见 [ADR 0001](0001-workspace-scoped-file-tools.md)，工具执行隔离与配对见 [ADR 0002](0002-isolate-tool-call-failures.md)，宿主 Bash 的进程组与输出约束见 [ADR 0003](0003-host-bash.md)，有效历史与摘要见 [ADR 0004](0004-conversation-summary.md)。Hook 的信任门禁不是沙箱；Bash 沙箱只约束 Bash 工具，见 [ADR 0005](0005-bash-sandbox.md)。