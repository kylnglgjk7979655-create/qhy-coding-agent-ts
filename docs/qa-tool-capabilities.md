# 工具权限、宿主 Bash、基础 MCP 与摘要：本地 QA 准备

本文交付子任务 #16 的可重复验收环境，最终人工 QA 为 #17，仍待人执行并记录版本、环境、逐项结果及缺陷。自动测试和代码审查不能代替人工 QA。MCP 独立断连、超时、取消及结果未知的专项边界按需求评论延期，不在本轮集成或人工 QA 中重新引入，也不宣称已完成。

夹具使用真实 OpenAI 兼容 HTTP/SSE 和 Streamable HTTP/JSON-RPC 协议，复用 `tests/helpers/local-openai-fixture.ts` 和 `local-mcp-fixture.ts`。它按固定英文指令生成受控调用，不能理解任意自然语言，也不验证真实模型的语义判断或远端兼容性。两个 MCP 服务均提供 `echo`，其中 beta 使用 Streamable HTTP 的 SSE 响应，并非旧式 SSE 传输。仅监听 `127.0.0.1`，无需在线服务或真实账号。

## 启动两个终端

准备 Node.js 24.22.2、pnpm 9.12.3、Bash、Linux/macOS 终端，以及允许本机回环端口和 POSIX 进程组的环境。自动交互测试还使用系统 `script`、`/bin/sh` 和 `ps`。

终端 A 在仓库根目录执行：

```sh
pnpm build
pnpm exec tsx tests/helpers/local-qa-fixture.ts --directory "$PWD/.scratch/qa-local-normal" --scenario normal
```

`--directory` 必须指向不存在的新目录，父目录须存在。重复验收请使用新的目录名，夹具拒绝覆盖已有记录。出现 `QA_READY` 后，模型与两个 MCP 服务均已就绪，实际 URL 已填入 `work/.agent/settings.json`，不必手工替换端口。目录内包含：

```text
qa-local-normal/
├── work/
│   ├── .agent/settings.json      # 项目 settings，仅引用假凭据环境变量
│   ├── note.txt                  # 初始文本
│   ├── large.txt                 # 轮内增长触发摘要
│   ├── huge.txt                  # 必要内容无法容纳
│   └── worker.cjs                # 受控进程，写 child.pid、started.txt、延迟写 late.txt
└── .agent/conversations/
    └── qa-summary.json           # 旧格式输入夹具，含可识别原文，尚未压缩
```

终端 B 先把 `REPO` 改为本机仓库绝对路径，再执行。`CLI_NODE` 从仓库的 pnpm 入口取得锁定版本，切换启动目录后仍可直接使用：

```sh
REPO=/绝对路径/qhy-coding-agent-ts
cd "$REPO"
CLI_NODE="$(pnpm exec node -p process.execPath)"
QA_ROOT="$REPO/.scratch/qa-local-normal"
export TEST_MODEL_API_KEY=local-qa-model
export QA_MCP_HEADER=local-qa-mcp
cd "$QA_ROOT"
"$CLI_NODE" "$REPO/dist/cli.js" --workspace "$QA_ROOT/work" --conversation-id qa-normal
```

这两个环境变量只设置本地假值。配置中的 `apiKeyEnv` 引用 `TEST_MODEL_API_KEY`，`mcp.servers[0].headers.Authorization.env` 引用 `QA_MCP_HEADER`；不把真实令牌写入配置或验收记录。模型、审查及摘要共用本地模型地址；连接器将假请求头值注入 alpha 的请求头，不进入模型输入或产品历史。

产品历史位于 **CLI 启动目录** 的 `.agent/conversations/`。QA 预置的 `qa-summary` 与新建的 `qa-normal` 是不同对话，不是历史归档。退出 CLI 用 `/exit`；夹具终端输入 `exit` 或按 Ctrl+C 结束服务。端口随新启动变化，新配置应与对应夹具进程配套使用。验收目录由人保留或清理，夹具不会自动删除记录。

## 正常操作与跨进程续聊

在 CLI 输入以下固定指令；终端 A 输入 `status` 可看主模型、审批、摘要请求数及两个服务的实际调用数，不打印参数、响应或请求头。

| CLI 输入 | 操作及预期 |
| --- | --- |
| `mixed` | 同批依次提出参数错误、未知工具、拒绝写入、批准写入和读取、Bash 非零退出、远端普通错误、Bash 写入及读取、另一服务成功调用、运行信息。前面普通失败不阻止后续调用 |
| `remote` | 调用 alpha、beta 的同名远端工具，名称分别为 `mcp_alpha_echo`、`mcp_beta_echo`；主模型按本轮公布的 schema 生成参数 |
| `recover` | 无工具的成功回复，用于确认普通错误后仍可续聊 |
| `pairing` | 提供重复调用 ID，执行前报告 `PROVIDER_ERROR`，不创建 `pairing.txt`、`later.txt`，不审批、不调用远端、不发送后续主模型请求 |
| `oversized` | 读取 `huge.txt`，下一步必要内容超预算，报告 `CONTEXT_ERROR`，无后续主模型请求、不保存失败轮 |
| `slow` | 启动独立 Bash 和受控子进程，记录 shell/子进程 PID；用于下文的超时与取消验证 |

新夹具和新 `qa-normal` 对话中执行一次 `mixed`，预期主模型请求 2 次、模型审批 6 次、alpha 与 beta 实际调用各 1 次。模型审批默认拒绝 `denied.txt`；未知工具及额外字段在审批前拒绝。`work/note.txt` 变为 `private-file-content`，`work/bash.txt` 为 `kept-bash`，`denied.txt` 不存在。终端只展示工具名和状态，不打印这些内容标记、命令输出、远端结果或假凭据；最终回复为 `夹具完成：mixed`。

在编辑器查看 `.agent/conversations/qa-normal.json`，核对 ID 顺序为 `invalid`、`unknown`、`denied`、`write`、`read`、`bash-failure`、`remote-failure`、`bash-write`、`bash-read`、`remote-ok`、`tail`，每个调用恰好一个结果。成功使用 `is_error: false` 与 `output`；普通失败使用 `is_error: true` 与 `error.code/message`。Bash 失败仍有退出码 7 和可用输出。历史中不应出现假认证头值。

终端 A 的 `schema-v2` 将 alpha 的 schema 改为必需字符串字段 `value`，`schema-v1` 恢复必需字段 `text`；下一轮 `remote` 重新发现后使用新定义，beta 保持原定义。可用人工审批在远端调用前暂停，修改定义后再批准：当前轮的公布与校验仍沿用原快照；下一轮才刷新。远端夹具同时接受两种已批准参数形状，避免把工具定义更新误作远端故障专项。

## 小预算、摘要及失败保护

生成配置刻意使用小预算：`capacityTokens: 10000`、`answerReserveTokens: 1000`、`triggerRatio: 0.6`、`targetRatio: 0.5`、`keepRecentTurns: 0`。这是 QA 设置，产品默认值仍为 128000、8192、0.8、0.5、2。估算覆盖系统提示、消息与实际工具定义，不要求与服务端精确 token 数相同。

退出当前 CLI，用同一启动命令将 conversation ID 换为 `qa-summary`，输入 `growth`。它先批准写入 `kept.txt`、调用 alpha，再读取 `large.txt`；增长会在下一次主模型请求前触发独立摘要。预期本次增加主模型请求 2 次、审批 2 次、摘要 1 次、alpha 调用 1 次，最终回复 `夹具完成：growth`。当前轮的三个工具调用与结果保留，较早的 `原文标记` 被 `[对话摘要]` 替换。

成功保存后检查 `.agent/conversations/qa-summary.json`，只保留摘要和完整当前轮，不创建原文归档或独立摘要文件。退出并以相同 ID 重启，输入 `recover`，历史继续包含摘要而不恢复原文。**压缩后成功保存会丢失被替换原文的完整内容**。摘要只作为 assistant 历史资料，不改变系统提示或工具策略；产品不自动读取开发用 AGENTS.md。

故障场景每次在终端 A 重新启动夹具，使用新的 `--directory` 和下列 `--scenario`；终端 B 同步修改 `QA_ROOT`，读取新配置：

| `--scenario` | CLI 输入和预期 |
| --- | --- |
| `approval-error` | 在新 `qa-fault` 对话先输入 `recover` 保存成功历史，再输入 `fault`。写文件和 alpha 调用已完成，审批 `blocked.txt` 时返回 HTTP 500；报告 `APPROVAL_ERROR` |
| `approval-invalid` | 同上，审查返回无效决定；报告 `APPROVAL_ERROR` |
| `approval-timeout` | 同上，审查不答复；配置的 2000ms 审批上限到达后报告 `APPROVAL_ERROR` |
| `summary-error` | 使用预置 `qa-summary` 对话输入 `growth`；副作用发生后摘要服务返回 HTTP 500，报告 `CONTEXT_ERROR` |
| `summary-invalid` | 同上，摘要为空白，报告 `CONTEXT_ERROR` |

在故障前后可用 `cksum .agent/conversations/<ID>.json` 比较上次成功历史，校验值应不变。`kept.txt` 和 alpha 的已发送操作保留；审批故障时 `blocked.txt`、`later.txt` 不存在，无后续主模型请求。摘要故障时已读工具结果不继续发送给主模型。无原始故障响应或完整工具结果泄露。不要把失败描述为自动回滚。

在故障提示后继续输入 `recover`，CLI 应能成功回复并保存；失败轮工具往返不应混入成功历史。`status` 只反映真实收到的请求，不补造工具结果。`oversized` 和 `pairing` 同样应停止本轮；后续 `recover` 仍可成功。

可用 `--review-delay-ms 1000` 暂停每次模型审批一秒，期间检查文件、远端实际调用计数及开始事件；批准前均不得发生实际操作。延迟也占用整轮预算，测试长延迟时须相应设置 `approval.timeoutMs` 与整轮 `timeoutMs`。人工模式不请求审查模型，此选项不控制人工等待。

## 人工等待、命令超时与取消

结束 CLI 后在编辑器修改生成配置，再重启；配置仅在启动时读取。每个取消或进程实验使用全新验收目录，避免混淆上次留下的 PID 和标记文件。

将审批配置改为 `{"mode":"default","humanTimeoutMs":5000}`，`timeoutMs` 设为 1000，`bash` 设为 `{"timeoutMs":4000}`。输入 `slow`，人工界面展示完整命令及实际 `work` 目录；等超过一秒再按当前编号批准。等待中 `shell.pid`、`started.txt` 不存在，且不报整轮超时。批准后命令启动，继续消耗等待前剩余的执行预算；本轮在剩余时间耗尽时报告 `TIMEOUT`，后续 `later.txt` 和远端调用均不发生。

在另一全新目录将整轮上限改为 5000、Bash 上限改为 400，可验证单命令超时：Bash 返回普通调用失败，后续写入和远端普通调用继续，区别于整轮停止。`slow` 中的工作进程会在启动 2.5 秒后尝试写 `late.txt`；超时或取消后等待超过此时长，文件不应出现。

用 `work/shell.pid`、`work/child.pid` 检查 `ps -o pid,stat,command -p <PID>`，所管理的命令和子进程不应仍在运行（Linux 可能短暂显示已结束的 Z 状态）。不能只依据错误文本断言进程已被终止。

分别在人工等待期间和 Bash 已启动期间按 Ctrl+C，另用其他终端对 CLI PID 发送 SIGTERM。应取消并退出，退出码 130，无后续工具或模型请求，不保存失败轮；已有副作用保留。非交互管道与输入关闭时人工审批直接拒绝，人工超时只拒绝当前调用；用 `mixed` 可逐次检查编号、无效输入和迟到答复不会批准其他调用。固定允许与拒绝仍优先于人工审批。人工界面是展示完整参数的特例，普通进度和日志继续保持最小信息。

Bash 使用宿主当前用户权限；cwd 仅约束启动目录，不提供文件系统、网络或操作系统隔离。只在可丢弃的 QA 工作区执行受控命令。

## 权限规则回归与人工 QA

自动化回归覆盖分层 settings 合并与校验、实际文件目标读取/写入、Glob/Grep 路径过滤与审批、Bash 命令拆分及规则匹配、MCP 默认审批、模型审批会话上下文、Explore/子 Agent 委派和会话恢复。运行项目完整检查后，可单独用以下测试文件定位失败：

```sh
pnpm exec vitest run tests/config.test.ts tests/agent-execution.test.ts tests/search-tools.test.ts tests/bash.test.ts tests/mcp.test.ts tests/tool-approval.test.ts tests/explore-delegation.test.ts tests/conversations.test.ts tests/cli-process.test.ts
```

自动测试不等于人工 QA 已完成。人工验收需在本地夹具与可丢弃工作区中逐项确认：

1. 在用户级、项目级和本地 settings 分别配置权限，确认权限数组跨层合并去重、目标路径匹配及 `deny > ask > allow` 决策；检查旧 `approval.rules` 仍兼容。
2. 对 `read_file`、`write_file`、`glob`、`grep` 分别试验工作区内外目标、符号链接目标、允许/审批/拒绝规则；搜索结果不得包含被拒绝文件，审批期间不得读取或写入。
3. 用精确命令和 `Bash(prefix *)` 检查简单命令与复合命令；混合规则中只要一条命令被拒绝，整次调用不得启动。无规则时 Bash 进入所选审批；可识别但需要谨慎执行的复合语法额外要求审批，无法可靠解析的控制结构作为无效参数拒绝。
4. 检查 MCP 工具默认进入所选审批，`MCP(server/tool)` 规则按完整服务名和工具名生效；等待或拒绝期间不得发送远端调用。
5. 从 Explore 和 general-purpose 子 Agent 分别请求读取与搜索，确认二者采用相同权限规则；Explore 不能写入、执行命令或委派，子 Agent 不能继续创建子 Agent。测试 `Agent` 拒绝规则。
6. 在 `approval.mode: "auto"` 下检查模型请求包含规则和受控历史摘要、用户消息、先前工具参数/状态，但不包含工具结果；在人工模式下确认只按当前审批编号批准单次调用。
7. 验证审批失败、取消、超时和跨进程续聊：失败轮不进入有效历史，已有文件或远端副作用保留，不应描述为自动回滚。

记录 QA 运行的版本、操作系统、配置层级、每项结果和缺陷。当前提交的自动化通过状态不会自动将人工 QA 标记为完成；执行记录追加到 [verification.md](verification.md)。

## 配置字段与验证入口

以下均为产品配置，不是夹具命令行参数。完整严格校验范围和示例见 [README](../README.md)。未知字段、错误类型和无效凭据引用应在工具操作前报 `CONFIG_ERROR`。

| 字段 | 产品默认值 / 用途 |
| --- | --- |
| `timeoutMs`、`maxSteps` | 60000ms、20；整轮执行预算与主模型步骤上限 |
| `approval.mode`、`approval.rules` | `default`、空规则；`auto` 使用独立模型审批，规则为 `{toolName, action}` |
| `approval.timeoutMs`、`approval.humanTimeoutMs` | 30000ms、300000ms；人工等待不扣整轮执行预算，不重置此前已消耗时间 |
| `approval.model` | 可选 `{provider, model, baseURL, apiKeyEnv}`，默认复用主模型；独立审查携带受控上下文，不提供工具 |
| `permissions.allow`、`permissions.ask`、`permissions.deny` | 分别按文件路径、Bash 命令、MCP 服务/工具及 Agent/RuntimeInfo 能力配置；权限规则各层合并去重，`deny` 优先 |
| `bash.timeoutMs` | 30000ms；单命令上限，不能延长整轮预算 |
| `mcp.servers` | 每项 `{name, url, headers}`；请求头值仅用 `{env: "变量名"}` 引用 |
| `mcp.connectTimeoutMs`、`mcp.discoveryTimeoutMs`、`mcp.callTimeoutMs` | 10000ms、10000ms、30000ms；接入共用时限与取消入口，不代表延期专项边界已验收 |
| `context.capacityTokens`、`context.answerReserveTokens` | 128000、8192；可用输入预算为两者之差 |
| `context.triggerRatio`、`context.targetRatio`、`context.keepRecentTurns` | 0.8、0.5、2；保留完整轮次和当前轮，不拆工具配对 |

从仓库根目录执行自动验证：

```sh
pnpm build
pnpm exec vitest run tests/capability-integration.test.ts tests/local-qa-launcher.test.ts tests/human-approval.test.ts
pnpm check
pnpm demo:test
```

组合测试检查真实 CLI 请求、调用 ID、文件、磁盘历史和进程状态。其余现有回归覆盖文件边界、严格参数、模型步骤上限、流故障与配对、事件通知故障、旧历史、摘要预算及本地工具冒烟。`demo:bug` 故意失败，真实模型 `smoke` 会调用在线服务，均不纳入本轮常规验证。
