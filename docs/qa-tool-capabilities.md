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

生成配置刻意使用小预算：`capacityTokens: 21200`、`answerReserveTokens: 700`、`maxOutputTokens: 1000`，自动压缩阈值为 21200 − 1000 − 13000 = 7200。这是 QA 设置，产品默认值仍为 128000、8192、20000。估算覆盖系统提示、消息与实际工具定义，不要求与服务端精确 token 数相同。

退出当前 CLI，用同一启动命令将 conversation ID 换为 `qa-summary`，输入 `growth`。它先批准写入 `kept.txt`、调用 alpha，再读取 `large.txt`；增长会在下一次主模型请求前触发独立摘要。预期本次增加主模型请求 2 次、审批 2 次、摘要 1 次、alpha 调用 1 次，最终回复 `夹具完成：压缩后继续`。全部有效历史（含当前轮工具调用与结果）进入摘要，压缩后主模型只收到 `[对话摘要]` 续接包装，较早的 `原文标记` 不再出现。

成功保存后检查 `.agent/conversations/qa-summary.json`，只保留摘要续接包装和本轮最终回复，不创建原文归档或独立摘要文件。退出并以相同 ID 重启，输入 `recover`，历史继续包含摘要而不恢复原文。**压缩后成功保存会丢失被替换原文的完整内容**。摘要作为程序生成的 `user` 续接资料，不改变系统提示或工具策略；产品不自动读取开发用 AGENTS.md。

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

本组命令未启用沙箱，Bash 以宿主当前用户权限执行；cwd 仅约束启动目录，本组验证不覆盖文件系统、网络或操作系统隔离。只在可丢弃的 QA 工作区执行受控命令。需要验证隔离时按下一节启用沙箱。

## macOS Bash 沙箱人工验收

本节只适用于 macOS，必须在真实 `sandbox-exec` 环境执行。Linux 自动测试只覆盖计划生成、不可用路径、代理策略和假执行层，不能证明真实 Seatbelt 读写边界、网络代理或豁免行为。**本节全部项目当前处于待执行状态；在逐项记录版本、环境和结果之前，不得把沙箱人工 QA 标记为完成。** 自动化测试和代码审查不能代替本节人工验收。

### 准备与记录

使用项目锁定的 Node.js 24.22.2、pnpm 9.12.3，先确认 `pnpm check` 通过。准备可丢弃的验收目录，并让 CLI 的 `HOME` 指向独立目录，使内置敏感路径落在可清理位置；不要把真实密钥或真实 `~/.ssh` 内容用于验收：

```sh
REPO=/绝对路径/qhy-coding-agent-ts
CLI_NODE="$(cd "$REPO" && pnpm exec node -p process.execPath)"
export QA_ROOT="$(mktemp -d)"
mkdir -p "$QA_ROOT/work/.agent" "$QA_ROOT/qa-home/.ssh" "$QA_ROOT/qa-home/private" \
  "$QA_ROOT/qa-home/scratch" "$QA_ROOT/outside" "$QA_ROOT/limited-bin"
printf 'inside-read' > "$QA_ROOT/work/note.txt"
printf 'outside-read' > "$QA_ROOT/outside/read.txt"
printf 'private-key' > "$QA_ROOT/qa-home/.ssh/authorized_keys"
printf 'blocked' > "$QA_ROOT/qa-home/private/blocked.txt"
printf 'readable' > "$QA_ROOT/qa-home/private/readable.txt"
ln -s "$QA_ROOT/qa-home/.ssh/authorized_keys" "$QA_ROOT/work/key-link"
ln -s /bin/bash "$QA_ROOT/limited-bin/bash"
sandbox-exec -p '(version 1) (allow default)' /usr/bin/true && echo SEATBELT_READY
```

在现有可用的模型 settings 中追加以下沙箱配置（模型、地址和凭据沿用原配置；`127.0.0.1` 只用于验证代理危险地址拒绝，验收后移除）：

```json
{
  "approval": { "mode": "default" },
  "permissions": {
    "sandbox": {
      "enabled": true,
      "onUnavailable": "closed",
      "writePaths": ["~/scratch"],
      "writeDenyPaths": ["~/scratch/protected"],
      "readDenyPaths": ["~/private"],
      "readAllowPaths": ["~/private/readable.txt"],
      "networkAllow": ["example.com", "127.0.0.1"],
      "networkPorts": [443],
      "envPassthrough": ["QA_PASSTHROUGH", "QA_ROOT"],
      "bypassAllowedCommands": ["printenv QA_HOST_ONLY"]
    }
  }
}
```

记录 macOS 版本与架构、`sandbox-exec` 探测结果、提交号、Node/pnpm 版本、实际 settings（隐去凭据）和每项结果。启动 CLI 时设置两个测试变量，并保留审批模式为人工，逐次核对审批界面展示的执行模式和完整命令：

```sh
cd "$QA_ROOT"
export QA_HOST_ONLY=host-only
export QA_PASSTHROUGH=visible
HOME="$QA_ROOT/qa-home" "$CLI_NODE" "$REPO/dist/cli.js" --workspace "$QA_ROOT/work"
```

向 Agent 提出下列操作时，以人工审批界面展示的实际 `command`、`cwd`、`sandboxExecution`、`sandboxBypass` 和 `sandboxNotice` 为准；模型改写命令或参数时重新提出，不能把未按预期执行的结果记为通过。每次 Bash 调用按当前编号输入 `approve`。

### 启用与读写边界

- [ ] **SBX-01 基础隔离**：执行 `printf ok`；审批显示“沙箱内执行”，工具结果 `sandboxed: true`，命令正常返回 `ok`。
- [ ] **SBX-02 最小环境**：执行 `printf '%s|%s' "${QA_PASSTHROUGH-unset}" "${QA_HOST_ONLY-unset}"`；输出 `visible|unset`，证明只传入了 `envPassthrough`。
- [ ] **SBX-03 工作区读**：读取 `$QA_ROOT/work/note.txt`；内容 `inside-read` 进入工具结果，命令成功。
- [ ] **SBX-04 工作区外读默认允许**：读取 `$QA_ROOT/outside/read.txt`；内容 `outside-read` 返回。该结果说明读取边界宽于工作区，不等于可写。
- [ ] **SBX-05 内置敏感路径拒读**：读取 `$HOME/.ssh/authorized_keys`；命令失败，错误说明沙箱策略拦截且不泄露 `private-key`。
- [ ] **SBX-06 readDenyPaths 与 readAllowPaths**：读取 `$HOME/private/blocked.txt` 失败；读取 `$HOME/private/readable.txt` 成功；`ls $HOME/private` 仍失败，确认放行只针对精确文件而非整个目录。
- [ ] **SBX-07 符号链接不能绕过读拒绝**：读取 `$QA_ROOT/work/key-link`；失败且不返回 `private-key`。
- [ ] **SBX-08 工作区写**：执行 `printf inside > $QA_ROOT/work/marker.txt`；文件内容为 `inside`，结果 `sandboxed: true`。
- [ ] **SBX-09 工作区外写拒绝**：执行 `printf outside > $QA_ROOT/outside/marker.txt`；命令失败，`$QA_ROOT/outside/marker.txt` 不存在。
- [ ] **SBX-10 TMPDIR 可写**：执行 `printf tmp > "$TMPDIR/sandbox-tmp.txt"`；文件存在，输出成功。
- [ ] **SBX-11 writePaths 与 writeDenyPaths**：执行 `printf scratch > $HOME/scratch/ok.txt` 成功；执行 `printf protected > $HOME/scratch/protected` 失败，即使父目录在 `writePaths` 中也不创建文件。
- [ ] **SBX-12 内置防篡改路径**：分别尝试写入工作区 `.agent/settings.local.json`、`.claude/skills/evil.md`、`.agents/skills/evil.md`、`.git/hooks/pre-commit` 和 `.github/workflows/evil.yml`；对尚不存在的子树先用 `mkdir -p` 再写入（例如 `mkdir -p .claude/skills && printf evil > .claude/skills/evil.md`）。每次写目标文件都失败且未创建；`mkdir -p` 可能已创建允许的父目录（如 `.claude`），这不影响判定，但受保护的文件或子目录不得存在。
- [ ] **SBX-13 调用临时目录清理**：检查 `$TMPDIR` 中没有遗留本次 `qhy-sandbox-*` 目录；失败、超时或取消后同样不残留 profile 或临时目录。

### 网络代理

- [ ] **SBX-14 代理变量**：执行 `printf '%s' "$HTTPS_PROXY"`；输出为 `http://localhost:<随机端口>`，且 `$HTTP_PROXY`、`$ALL_PROXY` 使用同一端口。
- [ ] **SBX-15 白名单目标**：执行 `curl -fsS -o "$QA_ROOT/work/sbx-15-response.txt" -w '%{http_code}' https://example.com`；在可联网环境退出码为 0、输出非错误 HTTP 状态码，并在工作区生成响应文件。若验收环境无法访问公网，记录为“受环境阻塞”，不得标记通过。
- [ ] **SBX-16 域名拒绝**：执行 `curl -sS https://denied.example`；命令失败，`stderr` 出现 `<sandbox_violations>` 和 `host-not-allowed`，不产生对其他目标的直连。
- [ ] **SBX-17 端口拒绝**：执行 `curl -sS https://example.com:8443`；命令失败，违规汇总包含 `port-not-allowed`。
- [ ] **SBX-18 危险地址拒绝**：执行 `curl -k -sS https://127.0.0.1`；命令失败，违规汇总包含 `dangerous-address`，代理不建立到回环地址的隧道。
- [ ] **SBX-19 未配置网络**：把 `networkAllow` 改为 `[]` 并重启；执行 `printf '%s' "${HTTPS_PROXY-unset}"` 输出 `unset`，`curl` 无法访问网络。完成后恢复验收配置。
- [ ] **SBX-20 代理启动失败**：该项无法通过产品配置稳定制造；以 `tests/sandbox-execution.test.ts` 的自动化覆盖为准，人工记录“未人工覆盖”，不得据此声称代理启动失败路径已人工验收。

### 豁免与权限

- [ ] **SBX-21 豁免获准**：要求 Agent 调用 Bash，参数为 `command: "printenv QA_HOST_ONLY"`、`disableSandbox: true`；审批显示“沙箱外执行”“获准”，结果 `sandboxed: false`、`notice` 含“豁免获准”，输出 `host-only`。
- [ ] **SBX-22 豁免未获准**：要求 Agent 调用 Bash，参数为 `command: "printenv QA_HOST_ONLY; printf x > $QA_ROOT/outside/bypass-denied.txt"`、`disableSandbox: true`；审批显示“沙箱内执行”“未获准”，结果 `sandboxed: true`、`notice` 含“豁免未获准”，外部文件未创建，`QA_HOST_ONLY` 不出现。
- [ ] **SBX-23 豁免不绕过权限**：在 `permissions.deny` 中加入 `Bash(printf denied-by-policy)`，把相同命令加入 `bypassAllowedCommands`，再以 `disableSandbox: true` 请求；结果为 `PERMISSION_DENIED`，命令未执行，也不进入人工审批。
- [ ] **SBX-24 关闭沙箱时忽略豁免**：把 `enabled` 改为 `false` 并重启，继续以 `disableSandbox: true` 请求；审批显示“已忽略（沙箱未启用）”，结果 `sandboxed: false` 且不宣称隔离。

### fail-open 与 fail-closed

用缺少 `sandbox-exec` 的受限 `PATH` 模拟沙箱不可用。受限目录只放 `bash`，命令使用 shell 内建 `printf`，避免依赖其他外部程序：

```sh
cd "$QA_ROOT"
PATH="$QA_ROOT/limited-bin" HOME="$QA_ROOT/qa-home" \
  "$CLI_NODE" "$REPO/dist/cli.js" --workspace "$QA_ROOT/work"
```

- [ ] **SBX-25 fail-closed 拒绝**：保持 `onUnavailable: "closed"`，执行 `printf x > should-not-execute.txt`；审批显示沙箱不可用与“拒绝执行”，结果为 `TOOL_EXECUTION_ERROR`，文件未创建，未启动命令进程。
- [ ] **SBX-26 fail-open 未隔离**：把 `onUnavailable` 改为 `"open"` 并重启，执行同一命令；审批显示“沙箱外执行”和未隔离说明，结果 `sandboxed: false`、`notice` 含“未隔离”，文件创建。该项只验证 fail-open 会实际失去隔离，不能视为安全通过。
- [ ] **SBX-27 恢复真实环境**：移除受限 `PATH`，确认正常启动后重新探测 `sandbox-exec`，基础命令再次得到 `sandboxed: true`；若未恢复，记录环境缺陷而不是改动产品结论。

### 记录与判定

至少记录以下字段，并附命令、审批截图或文本、工具结果和文件状态等证据；某项失败时记录缺陷编号与复现步骤，不将其他项的成功视为该项通过。执行记录追加到 [verification.md](verification.md)。

| 记录项 | 内容 |
| --- | --- |
| 版本与环境 | 提交号、macOS 版本与架构、Node.js、pnpm、`sandbox-exec` 探测结果 |
| 配置 | 使用的 settings 层级与实际沙箱字段（隐去凭据） |
| 逐项结果 | SBX-01–SBX-27 的通过/失败/阻塞/未覆盖及证据 |
| 缺陷 | 现象、实际命令与参数、预期、日志或文件状态、修复状态 |
| 人工 QA 状态 | 仍在执行时保持“待执行”；全部适用项通过后才可标记完成，受环境阻塞和未人工覆盖项须单独列出 |

## Hook 人工与黑盒验收

Hook 的自动化回归覆盖配置校验、分层合并与去重、信任记录、六个事件、参数改写、反馈注入、受众区分、子 Agent 范围、后台通知轮次、Stop 续跑和输出上限。Linux 自动测试不能替代真实终端的人工交互；**本节全部人工项当前处于待执行状态**，在逐项记录版本、环境和结果之前，不得把 Hook 人工 QA 标记为完成。

先构建并执行相关回归：

```sh
pnpm build
pnpm exec vitest run tests/hooks-config.test.ts tests/hooks-trust.test.ts tests/hooks-runner.test.ts \
  tests/hooks-session-start.test.ts tests/hooks-user-prompt-submit.test.ts \
  tests/hooks-pre-tool-use.test.ts tests/hooks-post-tool-use.test.ts \
  tests/hooks-post-tool-use-failure.test.ts tests/hooks-stop.test.ts \
  tests/hooks-subagent-scope.test.ts tests/hooks-round-scope.test.ts \
  tests/hooks-output-observability.test.ts
```

### 准备

使用可丢弃目录、独立 `HOME` 和本地 QA 夹具。夹具写在独立目录中；不要把测试 Hook 配置进真实用户 settings。

```sh
REPO=/绝对路径/qhy-coding-agent-ts
cd "$REPO"
pnpm build
CLI_NODE="$(pnpm exec node -p process.execPath)"
export PATH="$(dirname "$CLI_NODE"):$PATH"
QA_PARENT="$(mktemp -d)"
FIXTURE_DIR="$QA_PARENT/qa-local-hooks"
pnpm exec tsx tests/helpers/local-qa-fixture.ts --directory "$FIXTURE_DIR" --scenario normal
```

终端 A 出现 `QA_READY` 后，在终端 B 准备 Hook 脚本。脚本把每次 stdin 追加到 `qa-hooks/events.jsonl`，并按第一个参数模拟不同结论；它只用于验收，不属于产品。

```sh
mkdir -p "$FIXTURE_DIR/home" "$FIXTURE_DIR/work/.agent/hooks" "$FIXTURE_DIR/work/qa-hooks"
cat > "$FIXTURE_DIR/work/.agent/hooks/hook.mjs" <<'JS'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'record';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const text = input.trim();
mkdirSync('qa-hooks', { recursive: true });
appendFileSync('qa-hooks/events.jsonl', `${text}\n`);
const data = text === '' ? {} : JSON.parse(text);
const event = data.hook_event_name ?? 'unknown';
const emit = (value) => process.stdout.write(JSON.stringify(value));

if (mode === 'context') {
  emit({ systemMessage: `SYSTEM-${event}`, hookSpecificOutput: { additionalContext: `CONTEXT-${event}` } });
} else if (mode === 'plain') {
  process.stdout.write(`PLAIN-${event}\n`);
} else if (mode === 'rewrite' && event === 'PreToolUse'
  && data.tool_name === 'write_file' && data.tool_input?.path === 'note.txt') {
  emit({ hookSpecificOutput: { updatedInput: { path: 'note.txt', content: 'hook-rewritten' } } });
} else if (mode === 'bad-rewrite' && event === 'PreToolUse'
  && data.tool_name === 'write_file' && data.tool_input?.path === 'note.txt') {
  emit({ hookSpecificOutput: { updatedInput: { path: 7, content: 'invalid' } } });
} else if (mode === 'stop-once' && event === 'Stop') {
  if (!existsSync('qa-hooks/stop-continued')) {
    writeFileSync('qa-hooks/stop-continued', '1');
    emit({ decision: 'block', reason: 'STOP-CONTINUE-ONCE' });
  }
} else if (mode === 'timeout') {
  writeFileSync('qa-hooks/hook-shell.pid', String(process.pid));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeFileSync('qa-hooks/hook-child.pid', String(child.pid));
  await new Promise(() => {});
} else if (mode === 'output-limit') {
  process.stdout.write('x'.repeat(1024 * 1024 + 1));
  await new Promise(() => {});
}
JS
```

在编辑器中把以下 `hooks` 对象加入 `$FIXTURE_DIR/work/.agent/settings.json` 顶层，与 `model`、`approval` 同级。每次修改 settings 后重启 CLI；配置只在启动时读取。修改 Hook 命令、matcher 或超时会令已有信任失效；后续单项可加 `--trust-hooks` 跳过重复确认，或在交互提示中输入 `yes`。`qa-hooks/events.jsonl` 跨检查累积；逐项判定前先记录当前行数或清空文件，再只比较本次新增条目。

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs context", "timeoutMs": 10000 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs context" }] }],
    "PreToolUse": [{ "matcher": "Bash|write_file", "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs context" }] }],
    "PostToolUse": [{ "matcher": "Bash|write_file", "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs context" }] }],
    "PostToolUseFailure": [{ "matcher": "Bash|write_file", "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs context" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node .agent/hooks/hook.mjs record" }] }]
  }
}
```

启动命令如下；`HOME` 必须指向独立目录，使信任记录和会话记录都可清理：

```sh
cd "$FIXTURE_DIR/work"
HOME="$FIXTURE_DIR/home" TEST_MODEL_API_KEY=local-qa-model QA_MCP_HEADER=local-qa-mcp \
  "$CLI_NODE" "$REPO/dist/cli.js" --workspace "$FIXTURE_DIR/work" --conversation-id qa-hooks
```

### 信任与禁用

- [ ] **HOOK-01 交互确认后启用**：在真实 TTY 启动上述命令且尚无信任记录。确认界面列出全部 Hook 的事件、matcher、命令和可选 `timeoutMs`；输入 `yes` 后 SessionStart 执行，`qa-hooks/events.jsonl` 出现 `SessionStart`。检查 `$FIXTURE_DIR/home/.qhy-coding-agents/trusted.json` 存在，文件权限 `0600`、目录权限 `0700`，内容含 64 位十六进制 hash；终端出现 `[hook] SessionStart: SYSTEM-SessionStart`，但不出现 `CONTEXT-SessionStart`。
- [ ] **HOOK-02 拒绝确认**：删除 `trusted.json`，重新启动并输入 `no` 或其他非 `yes` 内容。终端显示“已禁用全部 Hook”，本次不追加任何 Hook 事件，也不生成信任记录；普通对话仍可继续并用 `/exit` 退出。
- [ ] **HOOK-03 非 TTY 未信任禁用**：删除 `trusted.json`，用管道启动且不带显式 opt-in：`printf '/exit\n' | HOME="$FIXTURE_DIR/home" TEST_MODEL_API_KEY=local-qa-model QA_MCP_HEADER=local-qa-mcp "$CLI_NODE" "$REPO/dist/cli.js" --workspace "$FIXTURE_DIR/work"`。stderr 出现“检测到未信任的 Hook 配置，已禁用全部 Hook”，事件日志无新增，信任记录不存在。stdout 不是 TTY 或 stdin 关闭同样适用。
- [ ] **HOOK-04 显式 opt-in**：分别使用 `--trust-hooks` 与 `QHY_TRUST_HOOKS=1` 启动。两者都应跳过确认、执行 Hook 并写入信任记录；`QHY_TRUST_HOOKS` 只接受去空白后等于 `1` 的值。
- [ ] **HOOK-05 全局禁用优先**：在已有信任记录时，用 `--no-hooks` 启动；事件日志无新增，不显示确认提示或未信任警告。再把 `"disableAllHooks": true` 加入 settings 并重启，结果相同。两项均优先于信任判断。
- [ ] **HOOK-06 配置变化使信任失效**：先把 `disableAllHooks` 恢复为 `false` 并在已有信任记录时修改任一 Hook 的 `command`、`matcher` 或 `timeoutMs`，重启。交互终端应重新展示确认；非 TTY 应禁用全部 Hook。只修改 `model`、`approval` 等无关字段时不应重新确认。

### 事件、受众与改写

- [ ] **HOOK-07 六个事件与 stdin**：使用上面的基础配置和新的会话 ID（例如启动时加 `--conversation-id qa-events`；与 HOOK-01 的 `qa-hooks` 区分），输入 `mixed`，随后 `/exit`。`qa-hooks/events.jsonl` 应包含全部六个事件：`SessionStart`（`source: "startup"`）、`UserPromptSubmit`（`prompt: "mixed"`）、`PreToolUse`（匹配 `Bash` / `write_file`）、`PostToolUse`、`PostToolUseFailure`（`mixed` 的 `bash-failure` 以非零退出让 Bash `execute` 抛错）、`Stop`。检查每条记录都有 `session_id`、`transcript_path`、`cwd`、`approval_mode: "model"`、`hook_event_name`；工具事件含 `tool_name`、`tool_use_id`，`PostToolUse` 含 `tool_response`。用同一 `--conversation-id qa-events` 重启并输入 `recover`，应新增一条 `SessionStart` 且 `source: "resume"`。
- [ ] **HOOK-08 受众与普通 stdout**：用新的会话 ID 在 `context` 模式下输入 `mixed`，终端只显示 `[hook] ... SYSTEM-<事件>`；会话记录 `$FIXTURE_DIR/home/.qhy-coding-agents/sessions/<会话 ID>/record.json` 的 `effectiveHistory` 只在 `SessionStart` / `UserPromptSubmit` 中出现 `<hook-context ...>CONTEXT-<事件>`，在工具事件中出现 `<hook-feedback ...>CONTEXT-PostToolUse>`，且不出现 `SYSTEM-` 文本。`PreToolUse` 的 `CONTEXT-PreToolUse` 不进入记录。把某个事件改为 `plain` 模式后重启：`SessionStart` / `UserPromptSubmit` 的 `PLAIN-<事件>` 作为隐藏上下文进入记录；`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop` 的普通 stdout 只显示 `[hook]` 行，不进入模型历史。`suppressOutput: true` 只隐藏该行，不改变上下文注入。
- [ ] **HOOK-09 updatedInput**：把 `PreToolUse` 的命令改为 `node .agent/hooks/hook.mjs rewrite`，用新的会话 ID 重启并输入 `mixed`。事件日志中的 `PreToolUse.tool_input.content` 仍是原始值 `private-file-content`；最终 `work/note.txt` 内容为 `hook-rewritten`，说明改写通过校验后用于审批与执行。再把命令改为 `node .agent/hooks/hook.mjs bad-rewrite`，用新的会话 ID 重启并输入 `mixed`；应出现 `[hook] PreToolUse: Hook 故障：updatedInput 未通过工具参数校验`，回退原参数继续审批，`note.txt` 内容保持 `private-file-content`，非法参数不得写入。
- [ ] **HOOK-10 PostToolUseFailure**：本地夹具的 `mixed` 指令包含 `bash-failure`（`printf private-command-output; exit 7`），Bash `execute` 会因非零退出抛错并触发该事件。确认事件日志中的 `PostToolUseFailure` stdin 含 `tool_name: "Bash"`、`error` 与 `error_code: "TOOL_EXECUTION_ERROR"`；工具结果仍为 `is_error: true`，会话记录在整批工具结果之后出现 `<hook-feedback event="PostToolUseFailure">`，已产生的标准输出和副作用不被撤销。`invalid`、`unknown`、`denied` 等审批前失败不应产生该事件。

### 超时、上限与 Stop

- [ ] **HOOK-11 超时与进程树**：把 `SessionStart` 的 Hook 命令改为 `node .agent/hooks/hook.mjs timeout` 并设置 `"timeoutMs": 1000`，用 `--trust-hooks` 重启。等待超过一秒，终端出现 `[hook] SessionStart: Hook 故障：执行超时（已忽略，不影响对话）`，CLI 继续进入输入循环。读取 `qa-hooks/hook-shell.pid` 与 `qa-hooks/hook-child.pid`，在另一终端执行 `ps -o pid,stat,command -p <PID>`；Hook 脚本进程与 `sleep` 子进程都不应仍在运行（Linux 可能短暂显示已结束的 `Z` 状态）。等待超过 30 秒后，不得出现新的 `sleep` 结果或残留进程。取消或超时都不能只凭提示文本断言进程已清理。
- [ ] **HOOK-12 输出上限**：把同一命令改为 `output-limit` 并设置 `"timeoutMs": 60000`，用 `--trust-hooks` 重启。stdout 超过 1 MiB 后应出现 `[hook] SessionStart: Hook 故障：stdout 超过 1 MiB，已终止`，结果按 `output_limit` 只提示不阻止；Hook 进程组被终止，会话继续。检查没有残留 `hook.mjs` 进程。
- [ ] **HOOK-13 Stop 单次续跑**：把 `Stop` 命令改为 `node .agent/hooks/hook.mjs stop-once`，删除 `qa-hooks/stop-continued`，用 `--trust-hooks` 和全新会话 ID 输入一次 `recover`。终端 A 的 `status` 中 `mainRequests` 应增加 2（第一次回答加一次续跑），不是 1 或更多；本次新增事件日志应恰好有两条 `Stop`，第一条 `stop_hook_active: false`，第二条 `true`。第一次理由 `STOP-CONTINUE-ONCE` 只进入续跑请求，第二次不再阻止；最终回答来自续跑，不能出现第三次 `Stop` 或循环续跑。

### 记录与判定

记录提交号、操作系统、Node.js / pnpm 版本、使用的 settings（隐去凭据）、逐项结果（通过 / 失败 / 阻塞 / 未覆盖）、命令与事件日志摘录、信任记录权限、进程 PID 检查结果和缺陷编号。真实模型未参与的项目注明环境限制，不以自动测试或代码审查代替人工结论。执行记录追加到 [verification.md](verification.md)，全部适用项通过后才可把 Hook 人工 QA 标记为完成。

## 权限规则回归与人工 QA

自动化回归覆盖分层 settings 合并与校验、实际文件目标读取/写入、Glob/Grep 路径过滤与审批、Bash 命令拆分及规则匹配、MCP 默认审批、模型审批会话上下文、Explore/子 Agent 委派和会话恢复。运行项目完整检查后，可单独用以下测试文件定位失败：

```sh
pnpm exec vitest run tests/config.test.ts tests/agent-execution.test.ts tests/search-tools.test.ts tests/bash.test.ts tests/mcp.test.ts tests/tool-approval.test.ts tests/explore-delegation.test.ts tests/conversations.test.ts tests/cli-process.test.ts tests/sandbox-plan.test.ts tests/sandbox-platform.test.ts tests/sandbox-execution.test.ts tests/sandbox-bypass.test.ts tests/sandbox-unavailable.test.ts tests/sandbox-seatbelt.test.ts tests/sandbox-network.test.ts tests/network-proxy.test.ts tests/sandbox-guidance.test.ts
```

沙箱测试在非 macOS 平台跳过真实 Seatbelt 用例，只验证不可用路径、计划生成、假 `sandbox-exec` 执行层和代理策略；跳过不等于真实沙箱通过。

自动测试不等于人工 QA 已完成。人工验收需在本地夹具与可丢弃工作区中逐项确认：

1. 在用户级、项目级和本地 settings 分别配置权限，确认每层字段均严格校验、权限数组跨层合并去重、目标路径匹配及 `deny > ask > allow` 决策；确认旧 `approval.rules` 不再提供授权。
2. 对 `read_file`、`write_file`、`glob`、`grep` 分别试验工作区内外目标、符号链接目标、允许/审批/拒绝规则；搜索结果不得包含被拒绝文件，审批期间不得读取或写入。
3. 用精确命令和 `Bash(prefix:*)` 检查简单命令与复合命令；混合规则中只要一条命令被拒绝，整次调用不得启动。无规则时 Bash 进入所选审批；可识别但需要谨慎执行的复合语法额外要求审批，无法可靠解析的控制结构作为无效参数拒绝。
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
| `approval.mode` | `default`；`auto` 使用独立模型审批。旧 `approval.rules` 不提供授权 |
| `approval.timeoutMs`、`approval.humanTimeoutMs` | 30000ms、300000ms；人工等待不扣整轮执行预算，不重置此前已消耗时间 |
| `approval.model` | 可选 `{provider, model, baseURL, apiKeyEnv}`，默认复用主模型；独立审查携带受控上下文，不提供工具 |
| `permissions.allow`、`permissions.ask`、`permissions.deny` | 分别按文件路径、Bash 命令、MCP 服务/工具及 Agent/RuntimeInfo 能力配置；权限规则各层合并去重，`deny` 优先 |
| `permissions.sandbox.enabled`、`permissions.sandbox.onUnavailable` | `false`、`open`；启用后 v1 仅在 macOS 探测成功时隔离；不可用时 `open` 以宿主方式执行并标注未隔离，`closed` 在启动命令前拒绝 |
| `permissions.sandbox.writePaths`、`writeDenyPaths`、`readDenyPaths`、`readAllowPaths` | 默认空数组；跨 settings 层取并集去重；相对路径从工作区解析，`~`/`~/` 从家目录解析。写入只额外允许 `writePaths`，读拒绝后的 `readAllowPaths` 按真实路径精确放行 |
| `permissions.sandbox.networkAllow`、`networkPorts` | 默认 `[]`、`[443]`；白名单为空时不启动代理且没有网络；域名精确或 `*.` 子域匹配，端口按 TCP 端口校验 |
| `permissions.sandbox.envPassthrough`、`bypassAllowedCommands` | 默认空数组；前者追加传入沙箱的环境变量名，后者仅用于按整条命令的全部简单命令审批 `disableSandbox` 豁免 |
| `bash.timeoutMs` | 30000ms；单命令上限，不能延长整轮预算 |
| `mcp.servers` | 每项 `{name, url, headers}`；请求头值仅用 `{env: "变量名"}` 引用 |
| `mcp.connectTimeoutMs`、`mcp.discoveryTimeoutMs`、`mcp.callTimeoutMs` | 10000ms、10000ms、30000ms；接入共用时限与取消入口，不代表延期专项边界已验收 |
| `context.capacityTokens`、`context.answerReserveTokens`、`context.maxOutputTokens` | 128000、8192、20000；自动压缩阈值为容量减去 `min(maxOutputTokens, 20000)` 与 13000 固定安全缓冲；回答预留独立控制普通回复输出上限 |
| `context.triggerRatio`、`context.targetRatio`、`context.keepRecentTurns` | 旧参数，仍可解析但已废弃并提示，不参与固定预算压缩算法 |

从仓库根目录执行自动验证：

```sh
pnpm build
pnpm exec vitest run tests/capability-integration.test.ts tests/local-qa-launcher.test.ts tests/human-approval.test.ts
pnpm check
pnpm demo:test
```

组合测试检查真实 CLI 请求、调用 ID、文件、磁盘历史和进程状态。其余现有回归覆盖文件边界、严格参数、模型步骤上限、流故障与配对、事件通知故障、旧历史、摘要预算、沙箱计划与不可用路径、代理策略、宿主/沙箱执行、豁免及本地工具冒烟。`demo:bug` 故意失败，真实模型 `smoke` 会调用在线服务，均不纳入本轮常规验证。
