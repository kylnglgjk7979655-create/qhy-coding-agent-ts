# qhy-coding-agent-ts

基于 AI SDK 7 的交互式 CLI Agent：启动后逐条输入需求，流式查看回答，输入 `/exit` 结束对话。Agent 提供 `read_file`、`write_file`、`runtimeInfo` 和 `Bash`，可读取工作区文件，并在工具策略允许或所选审批通过后修改文件、运行宿主命令。审批默认由独立模型完成，也可切换人工模式。会话记录保存在用户目录 `~/.qhy-coding-agents/sessions/`，支持用 conversation ID 跨进程继续对话。

通过 `ToolLoopAgent.stream()` 运行工具循环，每个对话轮次使用独立的 `maxSteps` 限制，默认 20 步。Agent 可通过 Bash 运行项目测试，文件工具与 Bash 共用策略、审批、串行执行和结果路径。

## 项目结构

```text
src/
├── cli.ts                 # CLI 启动入口
├── cli/                   # 交互输入
├── query/                 # Agent 执行循环
├── services/
│   ├── api/               # 模型通信
│   ├── compact/           # 上下文摘要
│   ├── mcp/               # 远端 MCP 连接
│   ├── session/           # 会话、锁和文件检查点
│   └── settings/          # 配置加载
├── tools/
│   ├── BashTool/          # 宿主命令执行
│   ├── FileReadTool/      # 文件读取
│   ├── FileWriteTool/     # 文件写入
│   ├── GlobTool/          # 文件路径搜索
│   ├── GrepTool/          # 文件内容搜索
│   ├── RuntimeInfoTool/   # 运行时信息
│   └── register-built-in-tools.ts  # 内置工具的统一注册入口
└── utils/                 # 共用错误处理
tests/                     # 行为和集成测试
```

CLI 入口保留在 `src/cli.ts`，构建后仍为 `dist/cli.js`。内置工具和远端 MCP 工具均通过 `ToolRegistry` 注册，统一执行参数校验、审批及结果处理。

## 从干净终端启动

需要 Git、可运行 pnpm 的 Node.js 和 pnpm 9.12.3。项目通过 `.npmrc` 的 `use-node-version=24.22.2` 自动选择运行时；首次运行会下载并缓存该版本，不需要手动切换终端的 Node.js。

```sh
git clone https://github.com/kylnglgjk7979655-create/qhy-coding-agent-ts.git
cd qhy-coding-agent-ts
pnpm --version   # 9.12.3
pnpm install --frozen-lockfile
pnpm exec node --version   # v24.22.2
cp .env.example .env
```

在编辑器中打开 `.env`，填写火山方舟的 `ARK_API_KEY`。也可以在终端环境中设置同名变量；已有环境变量优先于 `.env`。密钥不会放入 JSON 配置或运行日志，`.env` 已被 Git 忽略。

```sh
pnpm check
pnpm build
pnpm exec node dist/cli.js --workspace ./demo
```

启动后在提示符后输入消息，每次回答结束后再输入下一条，例如：

```text
介绍你的能力
读取 src/checkout.ts，说明折扣逻辑
/exit
```

消息在启动后输入，命令行不接受位置参数。省略 `--conversation-id` 时生成新对话 ID；发送首条消息后，可从 stderr 的 `run.started`、`run.finished` JSON 日志中获取 `conversationId`。后续在同一个启动目录传入该 ID，加载历史并继续输入消息：

```sh
pnpm exec node dist/cli.js --workspace ./demo --conversation-id "$CONVERSATION_ID"
```

将 `CONVERSATION_ID` 设置为日志中的实际 ID。用户消息在轮次开始时保存；流式回答、工具调用和已取得的工具结果会在运行中按序增量保存。失败、取消或进程中断后，transcript 保留已观察内容并标记轮次状态；未完成的工具调用不会伪造成工具结果。只有成功轮次更新供续聊使用的有效历史。会话记录按 conversation ID 区分并原子更新，目录权限设为仅当前用户可访问。会话历史不随 `--workspace` 切换位置。

交互终端中输入 `/resume` 后用方向键按首条用户消息标题选择当前工作区会话，选择“查看全部会话”可跨工作区续聊；`/resume all` 直接列出所有工作区。回车选择，Esc 或 `/cancel` 取消。`/resume <ID>` 和 `--conversation-id <ID>` 仍可直接指定会话。输入 `/rewind` 后按方向键选择用户消息对应的文件检查点，先查看预览，再输入 `yes` 确认；若确认前文件状态变化，会刷新预览并再次要求确认。选择列表需要交互终端，管道输入会显示说明并退出该选择，不会按序号恢复。

维护者人工 QA：在真实终端启动 CLI，输入两条不同消息后运行 `/resume`，确认标题、更新时间与工作区可辨认，方向键移动和回车会续聊对应会话；打开“查看全部会话”选择其他工作区会话，再验证取消不会切换。对同一文件完成两次不同修改后运行 `/rewind`，选择较早用户消息，确认预览和最终恢复的是该消息执行前的内容；再试一次，在预览后从另一个终端修改目标文件，确认首次 `yes` 只刷新预览，第二次确认才恢复。用 Esc 和 `/cancel` 分别取消，确认文件不变；用管道运行 `/resume` 或 `/rewind`，确认选择立即退出且普通输入仍可继续。

公共运行入口 `runAgent` 在成功时返回 `effectiveHistory`，包含本轮实际使用的历史、本轮用户消息及完整响应，CLI 直接使用它原子保存及继续下一轮。较早历史可能已被对话摘要替换，保存时不会重新拼接原文。原有 `responseMessages` 仍仅表示本轮响应，其他结果字段保持可用。失败或取消不交付新的有效历史；此前成功的有效历史保持不变，但完整 transcript 仍保留本轮已观察到的进度。

Ctrl+C 会取消当前请求并退出，退出码为 130；等待输入时也可直接按 Ctrl+C 退出。失败或取消不会回滚此前已经发生的文件、宿主或远端副作用。

不需要构建的开发入口：

```sh
pnpm dev --workspace ./demo
```

如环境没有 pnpm，可使用 [pnpm 官方安装方法](https://pnpm.io/installation)安装 **9.12.3**。工程全部依赖安装与执行均使用 pnpm。`pnpm dev`、`pnpm build`、`pnpm test` 和 `pnpm exec node` 自动使用锁定的 Node.js；终端直接执行 `node` 仍使用系统版本。如需直接运行 `node dist/cli.js`，先使用 nvm/fnm 按 `.nvmrc` 或 `.node-version` 切换到 Node.js 24.22.2。

## 模型及运行配置

配置由用户级 `~/.agent/settings.json`、项目级 `<工作区>/.agent/settings.json` 和项目本地 `<工作区>/.agent/settings.local.json` 按此顺序合并；更具体的字段覆盖同名字段，权限列表跨层合并去重，其他数组整体替换。项目本地文件已加入 Git 忽略规则。工作区依次由 `--workspace`、用户级设置和启动目录确定；项目设置不能重定向工作区，也不会向父目录逐级发现。仓库示例位于 `demo/.agent/settings.json`，启动示例使用 `--workspace ./demo`。发现旧的 `agent.config.json` 时会提示迁移，但不会加载该文件。

```json
{
  "provider": "openai",
  "model": "doubao-seed-2.0-mini",
  "apiKeyEnv": "ARK_API_KEY",
  "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "timeoutMs": 60000,
  "maxSteps": 20,
  "explore": {
    "model": "doubao-seed-2-0-mini",
    "loadRootAgents": false
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `provider` | 当前仅支持 `openai` 协议适配器，通过 `@ai-sdk/openai` 调用兼容的 Chat Completions 服务；当前服务为火山方舟 |
| `model` | 实际模型 ID，必须支持 function/tool calling；当前配置 `doubao-seed-2.0-mini` |
| `apiKeyEnv` | 密钥的环境变量名，仅引用凭据；不接受 `apiKey` 等明文字段 |
| `baseURL` | 可选，默认 `https://api.openai.com/v1`；必须是无内嵌凭据、查询参数及片段的 HTTP(S) 地址 |
| `workspace` | 仅用户级 settings 可指定；命令行 `--workspace` 优先，缺省使用启动目录 |
| `timeoutMs` | 1–3,600,000ms；每轮独立计时，覆盖该轮的生成与工具循环；人工审批等待单独计时，超时通过 AbortSignal 中止请求 |
| `maxSteps` | 1–100，默认 20；每轮独立计步，达到上限仍在调用工具时该轮失败，交互模式继续等待输入 |
| `explore.model` | 可选；Explore 默认模型，未配置时使用主 Agent 的 `model`。`agent` 单次调用可用 `model` 覆盖；连接地址和凭据沿用主 Agent |
| `explore.loadRootAgents` | 可选，默认 `false`；设为 `true` 后向 Explore 提供工作区根目录的 `AGENTS.md`，文件缺失时继续调查，不自动加载子目录中的同名文件 |
| `bash.timeoutMs` | 可选，默认 30,000ms，范围 1–3,600,000ms；单次命令上限，同时受整轮剩余时限约束；`bash` 只接受此字段 |

未知字段、无效类型及越界数值会在网络请求前报错。自动重试关闭，避免鉴权失败反复请求。Ctrl+C 会中止当前请求。

自定义 `baseURL` 的服务必须兼容 OpenAI Chat Completions 及函数调用；仅能返回文本不足以认定工具兼容。缺少 settings 时，内置默认值使用 OpenAI 地址、`gpt-4.1-mini-2025-04-14` 和 `OPENAI_API_KEY`。

2026-11-03 的基础版本曾通过方舟真实模型和 `runtimeInfo` 工具验收，详见 [历史验收记录](docs/verification.md)。当前工具权限、Bash、基础 MCP 与摘要的离线验收入口见 [本地 QA 指南](docs/qa-tool-capabilities.md)；早期交互式文件工具的验收项目保留在 [QA 清单](.scratch/interactive-cli-file-tools/qa-checklist.md)。

## 长对话与历史替换

每次主模型请求前（包括同轮工具执行后的后续步骤），程序估算内置系统提示、完整消息和本轮实际工具定义（包括 MCP 名称、描述及参数 schema）的输入占用。估算使用序列化载荷的 UTF-8 字节数除以三并增加消息封装开销，不等于模型服务的实际 token 用量。请按所选模型设置容量与回答预留；预留同时作为主模型、审查及摘要请求的输出上限。

可在运行配置中加入以下对象，省略时使用相同默认值：

```json
{
  "context": {
    "capacityTokens": 128000,
    "answerReserveTokens": 8192,
    "triggerRatio": 0.8,
    "targetRatio": 0.5,
    "keepRecentTurns": 2
  }
}
```

可用输入预算为 `capacityTokens - answerReserveTokens`。达到预算的 80% 时，将较早历史送入独立摘要请求；默认复用主模型、地址和凭据，不提供工具执行能力。摘要提示要求保留目标、已确认决策、约束、关键操作结果和未完成事项，并如实记录已有副作用。最近两轮完整对话与整个当前轮次（含已发生的工具往返）保留，工具调用与结果不拆开；`keepRecentTurns: 0` 表示只完整保留当前轮次。同轮工具结果增长后会重新检查，只能压缩较早历史，后续步骤沿用替换后的历史。

`capacityTokens` 和 `answerReserveTokens` 接受 1–10,000,000 的整数，预留必须小于容量；`triggerRatio` 大于零且不超过一，`targetRatio` 大于零且小于触发阈值；保留轮数接受 0–100 的整数。对象拒绝未知字段。触发后如有可替换历史，摘要加必要内容须低于目标预算；无法满足、摘要为空、摘要异常或生成失败时，以 `CONTEXT_ERROR` 通知并停止本轮，不循环摘要或删除保留消息。如果没有较早历史可替换，必要内容仍在可用输入预算内则直接使用，超限则停止。

摘要作为 `assistant` 历史资料进入后续请求，不改变内置系统提示或工具策略。产品不会自动加载工作区的开发用 `AGENTS.md`，也不发现其他项目规则文件。旧格式历史无需迁移，未触发压缩时保留原有内容，达到阈值后按同样规则处理。

摘要校验成功后替换本轮内存有效历史；只有轮次成功后才将其写入会话记录的 `effectiveHistory`。完整 transcript 始终保存在 `~/.qhy-coding-agents/sessions/<conversation ID>/record.json`，每次观察到新内容时通过临时文件和原子替换更新，摘要不会删除或压缩 transcript。重启后直接加载摘要及保留轮次。摘要失败或摘要后本轮失败、取消时，有效历史保持上次成功状态，transcript 保留本轮已观察内容；已经发生的文件、宿主或远端副作用不会回滚。

独立审查请求按专用提示词与当前单次调用的名称、完整参数检查预算，不添加目标、历史或摘要；独立摘要请求按专用提示词与待压缩原文检查预算。两者超限时以 `CONTEXT_ERROR` 停止，不发送已知超限请求，也不分段摘要或自动删除历史。

主模型、审查和摘要请求共用整轮剩余 `timeoutMs` 与取消信号，不自动重试，不重置主模型 `maxSteps`；人工审批等待仍单独计时。运行 `pnpm build && pnpm exec vitest run tests/context-summary.test.ts` 可用本地模型夹具验证轮内增长、请求预算、失败保护和跨进程续聊，无需真实服务或凭据；自动测试不能代替最终人工 QA。

## 文件工具与工作区边界

| 工具 | 能力 |
| --- | --- |
| `read_file` | 接收 `path`，读取工作区内文本文件，将内容返回给 Agent |
| `write_file` | 接收 `path` 和 `content`，完整替换目标文件；文件不存在时创建，不自动创建父目录 |
| `runtimeInfo` | 返回工作区绝对路径和本轮运行探针 |
| `Bash` | 接收 `command` 和可选 `cwd`，在工作区内的启动目录运行独立宿主 Bash |

相对路径从配置的工作区解析；绝对路径仅在解析后的目标仍位于工作区内时允许。指向工作区外的符号链接会被拒绝。read_file 和 runtimeInfo 默认直接执行；write_file 默认进入当前审批策略。固定允许或审批通过均不能放宽文件路径与符号链接边界。文件访问失败会作为工具结果返回给 Agent，让它解释问题或继续处理。

终端实时显示 `[工具] read_file：开始`、`[工具] read_file：成功`、`[工具] read_file：失败` 或 `[工具] read_file：拒绝` 等执行状态，不直接打印工具参数、文件内容或原始异常。一次调用只显示一个终结状态；普通调用失败后，同批后续调用仍会执行，Agent 会收到各次工具结果并决定如何继续。Agent 的最终回答可以按用户要求引用文件内容。

## 宿主 Bash

宿主 Bash 在支持 POSIX 进程组的系统（Linux/macOS）上使用 PATH 中的 `bash`，以 CLI 当前用户权限执行。它不提供操作系统沙箱、文件系统隔离或网络隔离。`cwd` 只限制启动位置，命令仍可能访问工作区外的资源；内置文件工具的工作区边界继续有效。

`command` 必须为非空命令。省略 `cwd` 时从配置工作区启动；相对 `cwd` 从工作区解析，绝对路径也须位于工作区内。审批前解析实际目录，拒绝路径穿越、指向工作区外的符号链接、缺失目录及文件路径。人工审批展示原始完整参数和解析后的实际工作目录；启动前再次核验该目录，变化或不可用时拒绝执行并要求重新提交。批准不能放宽这些检查。

每次调用使用独立 shell，继承 CLI 环境，不保留上次调用的 `cd`、环境修改或其他 shell 状态；不接受 `env` 或其他模型自定义环境参数。Bash 默认进入所选审批，固定规则使用精确工具名称 `Bash`。等待或拒绝期间不会启动命令。

例如，将以下字段加入运行配置，缩短单次命令上限：

```json
{
  "bash": { "timeoutMs": 10000 },
  "approval": { "mode": "default", "humanTimeoutMs": 300000 }
}
```

默认单命令上限为 30 秒，计时从实际启动命令开始；人工思考时间不消耗整轮执行预算。单命令超时返回普通调用失败，同批后续调用继续；整轮超时、Ctrl+C 或 SIGTERM 停止当前轮次，不启动后续工具或模型请求。超时和取消以 SIGKILL 终止所管理的命令进程组，并等待命令结束。已有文件和其他宿主副作用不会回滚；不提供后台任务管理。

工具结果的 `output` 包含 `stdout`、`stderr`、`exitCode`、`signal` 和 `truncated`。输出按 UTF-8 文本返回，stdout 与 stderr 合计最多 64 KiB；超限标记 `truncated: true`，仍持续消费流以避免管道堵塞，截断处不返回残缺字符。结果不会直接打印到普通进度或日志，主模型可根据它回答用户。

退出码为 0 时返回 `is_error: false`；非零退出、启动失败和单命令超时返回 `is_error: true`、`TOOL_EXECUTION_ERROR` 及可用输出。超时结果保留终止信号，错误消息说明超时；取消和整轮超时走轮次停止通路。常规验证通过本地模型夹具和受控进程完成，不能代替最终人工 QA。

## 工具策略与审批

可在 settings 中添加 `approval`，省略时采用人工审批：

```json
{
  "approval": {
    "mode": "auto",
    "timeoutMs": 30000,
    "rules": [
      { "toolName": "read_file", "action": "allow" },
      { "toolName": "write_file", "action": "ask" }
    ]
  }
}
```

`rules` 只精确匹配工具名称，不支持通配符、路径或命令前缀。`allow` 直接执行，`deny` 直接拒绝，`ask` 进入审批。同名规则冲突时 `deny` 优先，其次 `allow`，然后 `ask`；无匹配规则时 read_file、runtimeInfo 默认允许，其他工具默认审批。未知工具或无效参数在审批前拒绝。修改参数或再次调用都需要重新判断，不复用上次批准。

每次模型审批使用独立请求，仅发送专用审查提示词和本次工具名称、完整参数，不发送用户目标、对话历史或文件执行结果，也不给审查模型提供工具。审查只接受 `approve` 或 `deny`，不能核验完整用户意图，不提供操作系统隔离。公共 `runAgent` 另提供可等待的 `approvalControl(call, signal)`，返回 `approve` 或 `deny`；固定策略优先，控制接口与仅用于观察的 `onToolEvent` 分离，答复不改变已批准的参数。

默认复用主模型名称、地址和凭据；也可设置独立审查模型（凭据仅引用环境变量）：

```json
{
  "approval": {
    "model": {
      "provider": "openai",
      "model": "your-review-model",
      "baseURL": "https://example.com/v1",
      "apiKeyEnv": "REVIEW_API_KEY"
    }
  }
}
```

设置 `approval.model` 时须提供非空 `model`；省略其中的地址或凭据引用则分别复用主模型设置。审批配置及模型配置都拒绝未知字段；URL 不得含凭据、查询参数或片段，`apiKeyEnv` 必须是合法环境变量名且变量非空。不接受明文 `apiKey`。

模型审批独立上限 `approval.timeoutMs` 默认 30 秒，范围为 1–3,600,000 毫秒，同时受整轮 `timeoutMs` 剩余时限与取消约束，不自动重试。等待期间不会启动操作或显示工具开始；明确拒绝显示“拒绝”，以 `PERMISSION_DENIED` 工具结果回传，其他普通调用继续。审查超时、不可用或响应无效产生用户可见的 `APPROVAL_ERROR` 并停止本轮，不再执行后续工具或请求主模型。此前副作用保留，失败轮不保存，CLI 仍可接收新消息；Ctrl+C 或 SIGTERM 取消并退出。

人工审批配置示例：

```json
{
  "approval": {
    "mode": "default",
    "humanTimeoutMs": 300000
  }
}
```

`approval.mode` 接受 `default`（默认人工审批）和 `auto`（独立模型审批）。`ask` 在两种模式下分别交给人工或模型审批。人工模式逐次展示工具名称、调用 ID 和完整参数，例如 `[人工审批 1] write_file`。输入 `approve 1` 批准，或 `deny 1` 拒绝；数字须与当前提示一致。答复只对应本次调用，不能用旧编号批准后续调用。无效输入（包括新的用户需求）不会被当作批准；请完成审批后再提交新需求。进入等待前已经排队的需求仍作为后续对话处理，不能成为审批答复。

人工等待独立上限 `approval.humanTimeoutMs` 默认五分钟（300,000ms），范围为 1–3,600,000 毫秒；它与模型审批上限分别配置。非交互管道、输入关闭或等待超时直接拒绝本次调用，其他普通调用继续，不请求模型代为审批。人工等待不消耗整轮执行预算；批准或拒绝后继续使用等待前的剩余时间，多次等待不会重置已消耗时间。Ctrl+C、SIGTERM 和公共入口的父级取消信号仍能立即中断等待并停止本轮。公共入口在人工模式下未提供 `approvalControl` 时直接拒绝。

完整参数仅在人工审批界面展示，便于判断待执行操作；普通进度、执行事件和日志不输出完整参数、结果或原始异常。观察回调失败只输出诊断，不替代审批也不改变决定。常规验证使用本地模型夹具与假凭据；自动测试不能代替最终人工 QA。

## 远程 MCP 工具

可配置远程 Streamable HTTP MCP 服务；不支持旧式 SSE 端点、本地 stdio、OAuth 或浏览器登录。在运行配置中添加：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "alpha",
        "url": "http://127.0.0.1:端口/mcp",
        "headers": { "Authorization": { "env": "QA_MCP_HEADER" } }
      }
    ],
    "connectTimeoutMs": 10000,
    "discoveryTimeoutMs": 10000,
    "callTimeoutMs": 30000
  }
}
```

请将端口替换为实际数字。省略 `mcp` 时不连接远程服务，`servers: []` 也可禁用连接。服务名须以小写字母开头，仅含小写字母、数字和连字符，最多 16 字符，不能重复；URL 必须是 HTTP(S)，不能包含凭据、查询参数或片段。所有新增对象均拒绝未知字段。

请求头统一使用 `{ "env": "环境变量名" }`，不接受明文头值。环境变量保存完整头值（Authorization 需要时包含 Bearer 前缀），必须非空且不含换行或非法字符；头名必须为合法 HTTP token，不得大小写重复或覆盖 Host、Content-Length、Content-Type、Accept、Connection、Mcp-Session-Id、Mcp-Protocol-Version。连接器在启动时解析引用并注入请求头，不将头值加入工具参数、模型请求、历史或普通日志。使用本地夹具时仅设置假凭据，不要使用真实令牌。

每个对话轮次在请求主模型前重新连接并发现工具（包括分页），本轮固定名称、描述和参数 schema；服务端变化在下一轮发现后生效。工具名为 `mcp_<服务名>_<远端名称>`，例如 `mcp_alpha_echo`，远端非字母、数字、下划线、连字符名称转换为 UTF-8 十六进制后缀。工具名最多 64 字符；转换后冲突、远端重复名称或名称过长均明确报错，不静默覆盖。不会将服务端 instructions 加入系统提示。

MCP 工具通过现有 registry 使用相同的参数校验、策略、逐次审批、串行执行、调用 ID、统一结果和执行事件。默认进入所选审批，远端只读提示不自动豁免；固定规则使用公布后的完整名称。等待或拒绝期间可发生连接与发现，但不会发送 `tools/call`。人工审批展示完整参数，普通进度不显示参数或结果。

远端 JSON Schema 的同一份快照用于公布及本地校验，支持常见的 draft-07、2019-09、2020-12 约束（未指定方言时采用 2020-12；format 按注解处理）；不支持的 schema 明确报错。参数错误在审批和远端操作前拒绝。成功时 `output` 保留 MCP 业务结果，远端 `isError` 返回普通 `TOOL_EXECUTION_ERROR` 并保留业务输出，同批后续调用继续。连接或发现失败只使相应服务本轮不可用，并提供简短提示。

连接、发现、调用的默认上限分别为 10 秒、10 秒、30 秒；以上三个配置项均接受 1–3,600,000 毫秒，独立上限不能延长整轮 `timeoutMs`。发现及调用接入同一整轮取消信号，停止后不启动后续操作；人工思考时间仍独立计时。客户端每轮结束关闭，不跨轮缓存定义，不自动重试工具调用；远程副作用不承诺撤销。MCP 独立断连、超时、取消及结果未知的专项边界按需求评论延期，本次基础接入不代表这些专项已验收。

客户端固定使用与现有 AI SDK 配套的 `@ai-sdk/mcp`，工具转换沿用其 [MCP 工具适配能力](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)。常规测试使用编译后 CLI、本地模型和真实 HTTP/JSON-RPC 夹具，无需在线服务。

### 独立启动本地 MCP 夹具

在仓库根目录运行：

```bash
pnpm exec tsx tests/helpers/local-mcp-fixture.ts
# 或使用 Streamable HTTP 的 SSE 响应（仍不是旧式 SSE 传输）
pnpm exec tsx tests/helpers/local-mcp-fixture.ts --sse
```

夹具只监听本机回环地址，打印实际 URL，将它填入上述 `mcp.servers[0].url`。工具为 `echo({"text":"任意文字"})`，传入 `{"text":"fail"}` 可选择普通工具错误场景，其他文字返回正常结果。请求头可省略；若保留 Authorization 配置，请在 CLI 环境中设置非空的 `QA_MCP_HEADER` 假值。夹具不会打印认证请求头；Ctrl+C 或 SIGTERM 关闭服务。此命令只启动 MCP，模型仍使用 CLI 的配置。若要同时启动本地模型与两个 MCP 服务，使用 [本地 QA 指南](docs/qa-tool-capabilities.md)中的组合夹具；无需真实模型或凭据。

运行 `pnpm build && pnpm exec vitest run tests/mcp.test.ts` 验证真实发现、命名空间、审批、固定策略、参数拒绝、普通失败、跨轮刷新及假认证标记的隔离。自动测试不能代替后续人工 QA；本文不声明延期专项边界通过。

## 真实模型与工具验收

配置凭据后执行，都会调用真实服务并产生相应 API 用量：

```sh
pnpm build
pnpm exec node dist/cli.js --workspace ./demo
pnpm smoke
```

在交互式 CLI 中输入“介绍你的能力”，确认出现非空完整回答，再输入 `/exit`，应以 0 退出。

`pnpm smoke` 构建后执行 `--smoke-tool`，无需终端输入，也不保存对话历史：先在工作区创建随机探针文件，首步强制调用 `read_file`，再将工具结果传回模型。当前检查要求读取结果与探针一致、最终回答包含探针，满足条件后记录 `toolSmokePassed: true` 并退出 0。工作区需可写，运行结束时清理临时探针文件。也可直接执行：

```sh
pnpm exec node dist/cli.js --workspace ./demo --smoke-tool
```

工具冒烟至少需要两步，`maxSteps < 2` 会报 `CONFIG_ERROR`。工具调用未满足要求、读取结果不符或最终回答未包含探针时，报 `TOOL_COMPATIBILITY_ERROR`，退出码为 6。`--smoke-tool` 不能与 `--conversation-id` 同时使用。变更模型、provider 或地址后应重新执行真实冒烟。

当前冒烟检查有一个已知限制：探针内容也出现在文件名中，而文件名会发送给模型，因此仅回显提示词也可能通过检查。`toolSmokePassed: true` 不能单独证明模型使用了工具返回的内容；相关反例见 QA 清单的 QA-43、QA-44，尚需修复。

## 日志与失败状态

stdout 输出回答、交互提示、工具名称和单轮错误；stderr 输出每行一个 JSON 事件，可独立保存日志：

```sh
pnpm exec node dist/cli.js --workspace ./demo 2> run.jsonl
```

每轮生成新的 run ID。`run.started` 记录模型配置、工作区及请求状态；`run.finished` 记录成功或失败，成功轮次还包含步数、工具调用次数和 token 用量。普通对话日志包含 `conversationId`，冒烟日志不包含该字段。启动配置错误也有终态记录。日志不包含密钥、用户需求或原始 provider 错误响应；轮次耗时从开始处理该条消息计算。

交互模式中，鉴权失败、超时、步数上限等普通轮次错误会记录错误码并继续等待输入；随后 `/exit` 仍可使进程以 0 退出，应结合每轮日志判断结果。下表的非零退出码适用于错误导致进程结束的场景，例如启动失败、冒烟失败或取消退出。

| 退出码 | 错误码 | 处理建议 |
| --- | --- | --- |
| 0 | 正常退出 | 交互模式正常结束，或工具冒烟通过；各轮结果查看日志 |
| 1 | `INTERNAL_ERROR` | 检查服务协议兼容性 |
| 2 | `CONFIG_ERROR` | 补齐凭据、修正配置、工作区或参数 |
| 3 | `AUTH_ERROR` | HTTP 401/403；检查密钥与服务权限 |
| 4 | `TIMEOUT` | 总时限或 HTTP 408/504；检查网络或调整时限 |
| 5 | `PROVIDER_ERROR` | 网络、配额、HTTP 错误，或回答为空/被截断 |
| 6 | `TOOL_COMPATIBILITY_ERROR` | 工具冒烟未通过 |
| 7 | `STEP_LIMIT` | 步数用尽，尚未完成回答 |
| 8 | `APPROVAL_ERROR` | 审批超时、不可用或响应无效，本轮停止 |
| 9 | `CONTEXT_ERROR` | 摘要失败、响应无效，或必要上下文无法满足预算与压缩目标 |
| 130 | `CANCELLED` | 用户取消 |

`pnpm test` 使用本地 HTTP fixture 运行真正的 SDK/provider 和编译后的 CLI，覆盖多轮对话、会话续接、成功保存、失败恢复、文件读写、越界拒绝、缺失父目录、冒烟成功、步数上限、超时和取消，并检查配置校验。这些测试使用假凭据，不需要真实 API key。

本地 fixture 需要监听 `127.0.0.1` 端口；真实终端取消测试在 macOS/Linux 上使用系统 `script` 和 `/bin/sh`，Windows 跳过该组测试。受限沙箱需允许本地端口与伪终端访问。工具权限、Bash、基础 MCP 和摘要的夹具启动、故障场景及配置修改见 [本地 QA 指南](docs/qa-tool-capabilities.md)。自动测试和代码审查不能代替最终人工 QA；人工 QA 保持待执行，真实服务验收需另行安排。

## 开发命令与版本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev [选项]` | tsx 执行 TypeScript CLI，启动交互式对话 |
| `pnpm build` | tsc 生成 ESM `dist/cli.js` |
| `pnpm typecheck` | 严格模式检查源码、测试和演示代码 |
| `pnpm test` | 构建后执行 Vitest 单元与 CLI 集成测试 |
| `pnpm check` | 类型检查与测试 |
| `pnpm smoke` | 构建后执行真实工具调用验收 |
| `pnpm demo:test` | 演示仓库基础测试，应通过 |
| `pnpm demo:bug` | 复现演示 bug，初始状态预期失败 |
| `pnpm demo:init` | 建立带干净起始提交的独立演示仓库 |

运行时锁定 Node.js **24.22.2**（`.npmrc` 自动选择，`.nvmrc`、`.node-version`、`engines` 同步声明），pnpm **9.12.3**（`packageManager`、`engines`）。CLI 要求 Node.js 24；pnpm 安装启用 `engine-strict`、`strict-peer-dependencies` 和 `save-exact`。TypeScript 使用严格模式、NodeNext ESM、未检查索引及精确可选属性检查。

| 包 | 精确版本 | 兼容核对 |
| --- | --- | --- |
| `ai` | 7.0.162 | Node >=22；Zod `^3.25.76 || ^4.1.8` |
| `@ai-sdk/openai` | 4.0.108 | Node >=22；同一 Zod peer 范围 |
| `zod` | 4.6.7 | 满足两个包的 peer 范围 |
| `typescript` | 5.9.3 | 开发与构建 |
| `tsx` | 4.23.15 | 开发执行 |
| `vitest` | 5.1.0 | 支持 Node 24；Vite peer `^6.4.0 || ^7.0.0 || ^8.0.0` |
| `vite` | 8.3.5 | 显式固定 Vitest 必需 peer |
| `@types/node` | 24.19.2 | Node 24 类型 |

`ai` 与 provider 均依赖 `@ai-sdk/provider@4.0.35`、`@ai-sdk/provider-utils@5.0.74`。上述版本已通过 pnpm 严格 peer 安装；直接依赖均无 `^`/`~`，传递依赖由 `pnpm-lock.yaml` 固定。AI SDK API 依据已安装包附带的 `src/agent/tool-loop-agent.ts` 和 `docs/03-agents/02-building-agents.mdx` 核对。

## GitHub Actions 与 Codex

仓库的 GitHub Actions 采用 Sandcastle 官方仓库的 Explore、Issue 实现、PR 审查、反馈修改和分支更新流程，模型继续使用 Codex 订阅。给独立 Issue 添加 `agent:implement` 后，Agent 实现并提交，workflow 创建草稿 PR 并通过 `agent:review` 请求审查，由人决定合并。`agent:explore` 会批量调查，自动转交明确任务并关闭重复 Issue；`ready-for-agent` 仅表示准备状态。普通实现不支持父子 Issue；旧的 PRD、拆票发布、依赖队列与定时架构审查已移除。

首次使用需把配置合入 GitHub 默认分支，并设置 `CODEX_AUTH_JSON`（CI 专用订阅登录）和 `CODEX_AUTH_STORE_PAT`（保存刷新结果）。工作流只在私有仓库运行，不需要 OpenAI API Key。完整配置与使用命令见 [GitHub Actions 与 Codex 订阅](docs/agents/github-actions.md)。

## TS 演示仓库

`demo/` 是可独立安装的 TypeScript 模板，自带精确依赖和 lockfile。`checkoutTotal` 的规则是“满 100 打九折”，已知 bug 是恰好 100 时返回 100。三个基础测试通过，单独回归测试预期 `100 → 90`，起始时失败。

```sh
pnpm demo:test
pnpm demo:bug   # 预期退出 1，用于复现已知 bug
pnpm demo:init
git -C .demo-workspace status --short
git -C .demo-workspace log -1 --oneline
```

`demo:init` 复制模板到忽略的 `.demo-workspace/`，初始化独立 Git 仓库、提交所有模板文件并创建 `demo-start` 标签，完成时保证工作区干净。已有目录时拒绝覆盖。该提交和 tag 是后续 Agent 修复任务的起点，父仓库直接跟踪模板文件以便分发。

独立验证副本：

```sh
cd .demo-workspace
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:bug   # 预期失败
git status --short  # 依赖已忽略，工作区应仍然干净
```

可用 `pnpm dev --workspace ./.demo-workspace` 启动 Agent，然后输入“读取 src/checkout.ts 和 regression/discount.test.ts，修复金额恰好为 100 时未打折的问题，并运行测试”。Agent 可以读取和修改文件，并在策略允许或审批通过后通过 Bash 在副本中执行测试命令。
