# Bash 在 macOS Seatbelt 沙箱内执行，网络经本机 CONNECT 代理

父需求 #136 的子任务 #137–#145 为 Bash 增加可配置的操作系统沙箱。本决策记录 v1 的隔离边界、执行模式、网络代理、豁免语义与失败取舍；宿主模式、审批和执行时序继续沿用 ADR 0003，本条只覆盖启用沙箱后的差异。v1 只实现 macOS Seatbelt，不声称 Linux、Windows 或其他平台具备操作系统沙箱。

## 配置与分层

沙箱位于 `permissions.sandbox`，默认 `enabled: false`。`enabled` 与 `onUnavailable` 由更具体的 settings 层覆盖；`writePaths`、`writeDenyPaths`、`readDenyPaths`、`readAllowPaths`、`networkAllow`、`networkPorts`、`envPassthrough`、`bypassAllowedCommands` 在用户级、项目级和项目本地层取并集并去重，项目层不能通过覆盖移除上层保护。数组项为空字符串无效；`envPassthrough` 必须是合法环境变量名，`networkPorts` 必须是 1–65,535 的整数，默认 `[443]`。

路径项 `~` 表示家目录，`~/...` 从家目录解析，其他相对路径从工作区解析；绝对路径保持原样。

## 平台探测与执行模式

进程内只探测一次：macOS 上执行 `sandbox-exec -p '(version 1) (allow default)' /usr/bin/true`，5 秒内成功才算可用；非 macOS 或探测失败一律视为不可用。探测结果只描述当前环境，不把“命令存在”单独当成沙箱可用。

每次 Bash 调用在审批前生成唯一的沙箱执行计划，审批展示与实际执行共同消费该计划，不重新推导执行模式、规则或环境。决策表如下：

| `enabled` | 平台探测 | `disableSandbox` | 计划 |
| --- | --- | --- | --- |
| `false` | 任意 | 任意 | 宿主执行，`reason: disabled`，豁免申请被忽略 |
| `true` | 不可用 | 任意 | `onUnavailable: open` 时宿主执行并标注未隔离；`closed` 时拒绝执行 |
| `true` | 可用 | 获准 | 宿主执行，`reason: bypass-approved` |
| `true` | 可用 | 未申请或未获准 | 沙箱执行，`reason: sandboxed` 或 `bypass-denied` |

`onUnavailable` 默认 `open`。`open` 是为兼容无 Seatbelt 的平台而保留的 fail-open：命令以 CLI 当前用户权限执行，审批详情带 `sandboxNotice`，工具结果带 `sandboxed: false` 与未隔离 `notice`。`closed` 是 fail-closed：在启动任何命令进程前以 `TOOL_EXECUTION_ERROR` 拒绝，并保留同一说明。两种模式都仍经过固定权限规则与逐次审批；沙箱不能用审批替代。

## Seatbelt profile 与读写边界

进入沙箱时，读取采用“默认允许 + 内置/用户读黑名单 + 精确回补”，写入采用“默认拒绝 + 写白名单 + 拒绝回补”的模型。执行层把 profile 写入本次调用临时目录的 `profile.sb`（0600），以 `sandbox-exec -f <profile> bash --noprofile --norc -c <command>` 启动独立进程组。profile 顺序固定，Seatbelt 以最后匹配的规则为准：

1. `(version 1)` 与 `(allow default)`。
2. `(deny file-read* ...)`：内置敏感读拒绝路径与 `readDenyPaths`。
3. `(allow file-read* ...)`：`readAllowPaths`。
4. `(deny file-write*)`：先全局拒绝写入。
5. `(allow file-write* ...)`：工作区、`$TMPDIR`（环境变量存在时）、本次调用临时目录与 `writePaths`。
6. `(deny file-write* ...)`：内置防篡改写拒绝路径与 `writeDenyPaths`。
7. `(deny network*)`，以及仅在代理启动成功时追加的 `(allow network-outbound (remote ip "localhost:<port>"))`。

读取默认允许，但固定拒读 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.azure`、`~/.git-credentials`、`~/.netrc`、`~/.npmrc`、`~/.password-store`、`~/.config/gh`、`~/.config/gcloud`、`~/.docker/config.json`、`~/Library/Keychains`、`~/.local/share/keyrings`、`~/Documents`、`~/Desktop`、`~/Downloads`、`~/Library/Messages`、`~/Library/Mail`、`~/Library/Safari`、`~/Library/Application Support/Google/Chrome`、`~/Library/Application Support/Firefox` 与 `~/.qhy-coding-agents`。`readAllowPaths` 在拒绝之后按配置路径及其子树放行；配置到单个文件时只放开该文件，同目录未列出内容仍拒读，配置目录则会放开其子树。

写入默认拒绝，仅工作区、`$TMPDIR`（环境变量存在时）、本次调用临时目录与 `writePaths` 可写。内置防篡改路径始终拒写：工作区内的 `.agent/settings.json`、`.agent/settings.local.json`、`.claude/settings.json`、`.claude/settings.local.json`、`.claude/skills/**`、`.agents/skills/**`、`.git/hooks/**`、`.git/config` 与 `.github/workflows/**`。用户 `writePaths` 不能覆盖这些拒绝。防篡改目标在生成计划时可能尚不存在，因此写拒绝按最近一个已存在祖先的真实路径解析后拼回缺失尾部；否则命令可先创建 `settings.local.json`，再借后续加载提权。

读允许与写允许只保留已存在的真实路径，避免为尚不存在的目标提前授予超出真实目录的权限。读拒绝、写拒绝与允许路径都按 `realpath` 解析，计划生成前建立的符号链接不能换成未解析路径绕过；工作区内的符号链接指向被拒绝目标时仍被拒绝。

沙箱 shell 只继承 `PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`、`TERM`、`SHELL`、`USER`、`LOGNAME`、`TZ`、`envPassthrough` 与代理变量。其余 CLI 环境（包括 API 密钥等）不会进入子进程。宿主模式仍继承完整 CLI 环境。每次调用使用独立 shell，不保留 `cd`、环境修改或其他 shell 状态。

## 本机 CONNECT 代理

沙箱内网络默认全部拒绝。`networkAllow` 非空且沙箱可用时，程序为本次调用启动一个只监听本机随机端口的 HTTP CONNECT 代理，profile 只放行该代理端口；沙箱内其他出站连接仍被拒绝。代理在调用结束、失败、超时或取消后关闭，调用临时目录同时删除；审批拒绝时由准备阶段的清理入口回收。

代理只接受 CONNECT，其他方法返回 405。目标按端口、域名、DNS、地址顺序校验：

- 端口必须存在于 `networkPorts`；否则记录 `port-not-allowed`，不解析 DNS。
- 域名精确匹配（忽略大小写与结尾的点）或匹配 `*.` 子域；`*.example.com` 不匹配裸 `example.com`，也不做后缀或子串匹配。未命中记录 `host-not-allowed`。
- DNS 由代理执行。解析失败或没有结果记录 `dns-failed`。
- 任一解析结果落入危险地址即拒绝，记录 `dangerous-address`：IPv4 的 `0/8`、`10/8`、`127/8`、`100.64/10`、`169.254/16`、`172.16/12`、`192.168/16`；IPv6 的未指定地址、回环、IPv4-mapped 危险地址、`fc00::/7` 与 `fe80::/10`；无法识别的地址按危险处理。连接只使用已校验的解析结果，不在连接时二次解析，避免 DNS rebinding。

上游不可达返回 502，不记为策略违规。代理只透传原始 TCP 字节，不终结 TLS、不安装 CA、不检查隧道内容。被拒绝的目标在调用结束时汇总为 `<sandbox_violations>` 文本附加到 `stdout`/`stderr` 所在的输出，成功命令写入 `stderr`，失败命令保留原错误与输出并附加相同文本；每项带稳定原因码。代理启动失败时计划只保留全局网络拒绝，不退回直连。

## 豁免语义

`Bash` 参数新增可选 `disableSandbox: true`，但它只是申请，不是授权。沙箱关闭时被忽略，审批显示“已忽略（沙箱未启用）”；沙箱不可用时未适用。只有沙箱可用、`bypassAllowedCommands` 非空，且 `analyzeBashCommand` 解析出的每个简单命令都命中排除表时，整条命令才以宿主方式执行，审批显示“获准”，结果带 `sandboxed: false` 与“豁免获准”说明。

任一简单命令未命中、排除表为空或命令无法可靠解析时，豁免未获准，整条命令仍在沙箱内执行，审批显示“未获准”，结果带 `sandboxed: true` 与说明。命令模式与 Bash 权限规则一致：精确匹配完整命令，末尾 `:*` 匹配该前缀及后续参数。豁免只改变隔离模式，不跳过 `permissions.deny`、`permissions.ask`、`permissions.allow` 或逐次审批；固定允许、审批和拒绝仍按原顺序生效。

## 审批、结果与清理

计划在审批前生成，因此人工审批与模型审批都能看到实际执行模式：`sandboxExecution` 为“沙箱内执行”“沙箱外执行”或“拒绝执行”，`sandboxBypass` 为豁免结果，`sandboxNotice` 说明沙箱不可用或豁免未获准。审查提示要求依据这些字段判断，不得假定命令默认在沙箱内或沙箱外。等待或拒绝期间不启动命令。

工具结果在原有 `stdout`、`stderr`、`exitCode`、`signal`、`truncated` 之外增加 `sandboxed`，需要说明时增加 `notice`。非零退出、启动失败、单命令超时与 fail-closed 拒绝继续作为 `TOOL_EXECUTION_ERROR`。沙箱内 stderr 出现 `Operation not permitted` 时，错误消息明确为沙箱策略拦截，而不是命令自身错误。超时与取消沿用 ADR 0003 的 SIGKILL 进程组终止；无论成功、失败、超时还是取消，代理都会关闭、临时目录都会删除。

## 已知残留风险与未覆盖边界

- 沙箱只约束 Bash 及其子进程。`read_file`、`write_file`、远程 MCP、审查模型、CLI 自身和其他进程不在沙箱内；文件工具的工作区边界仍是应用层策略。
- `enabled` 默认关闭。关闭时 Bash 不提供操作系统隔离；开启后仍可能因 fail-open 或豁免以宿主方式执行。
- fail-open 默认 `open`：沙箱不可用时命令实际在宿主运行，`notice` 只是提示，不能阻止模型或用户继续使用该结果。需要强制隔离的环境必须设置 `onUnavailable: "closed"`。
- 豁免获准的命令完全在沙箱外执行，继承 CLI 环境并可访问任意文件与网络。只有 `bypassAllowedCommands` 的配置和审批作为约束；若排除表包含宽泛或危险命令，等同于主动放开隔离。
- Seatbelt 是路径与主机级策略。`readAllowPaths`、`writePaths` 与用户拒绝列表的组合可能扩大访问面；内置拒绝列表不是穷举。硬链接、挂载别名、计划生成后创建的其他路径别名，以及 macOS 版本对 Seatbelt 语义的差异，仍可能产生未覆盖的访问路径。
- 网络策略只约束经代理的 CONNECT 目标，不检查 TLS 内容，也不限制允许主机上的路径、方法或数据。允许的域名可承载任意服务；被攻陷或恶意的允许主机仍可能用于数据外传。UDP、ICMP、原始套接字和不遵守代理环境变量的客户端在沙箱内没有网络，这是预期限制。
- 平台探测只证明 `sandbox-exec` 能执行最小 profile，不证明所有后续 profile 规则或 macOS 版本行为一致。`sandbox-exec` 在 macOS 上属于未公开接口，未来系统可能改变或移除；探测失败会转入不可用路径，但不会模拟完整隔离。
- Linux 等平台只能验证沙箱不可用、计划生成与假 `sandbox-exec` 的执行层路径；真实 Seatbelt 读写边界、代理与豁免必须在 macOS 人工验收中确认。自动化测试和代码审查不能代替该项人工 QA，当前人工验收仍待执行，清单见 [本地 QA 指南](../qa-tool-capabilities.md#macos-bash-沙箱人工验收)。