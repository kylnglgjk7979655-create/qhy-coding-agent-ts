# qhy-coding-agent-ts

基于 AI SDK 7 的交互式 CLI Agent：启动后逐条输入需求，流式查看回答，输入 `/exit` 结束对话。Agent 提供 `read_file`、`write_file` 和 `runtimeInfo`，可读取配置工作区内的文件，并在工具策略允许或独立模型审批通过后修改文件。会话历史保存在启动目录的 `.agent/conversations/`，支持用 conversation ID 跨进程继续对话。

通过 `ToolLoopAgent.stream()` 运行工具循环，每个对话轮次使用独立的 `maxSteps` 限制，默认 20 步。当前没有执行 shell 或运行项目测试的工具。

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

将 `CONVERSATION_ID` 设置为日志中的实际 ID。每个成功轮次保存用户消息、工具往返和 Agent 回复；失败或未完成的轮次不保存。普通单轮错误会显示原因并返回输入循环，已有成功历史保留。历史文件按 conversation ID 区分并原子更新，目录权限设为仅当前用户可访问。会话历史不随 `--workspace` 切换位置。

Ctrl+C 会取消当前请求并退出，退出码为 130；等待输入时也可直接按 Ctrl+C 退出。失败或取消不会回滚此前已经完成的文件写入。

不需要构建的开发入口：

```sh
pnpm dev --workspace ./demo
```

如环境没有 pnpm，可使用 [pnpm 官方安装方法](https://pnpm.io/installation)安装 **9.12.3**。工程全部依赖安装与执行均使用 pnpm。`pnpm dev`、`pnpm build`、`pnpm test` 和 `pnpm exec node` 自动使用锁定的 Node.js；终端直接执行 `node` 仍使用系统版本。如需直接运行 `node dist/cli.js`，先使用 nvm/fnm 按 `.nvmrc` 或 `.node-version` 切换到 Node.js 24.22.2。

## 模型及运行配置

默认读取当前目录的 `agent.config.json`，项目已配置火山方舟 Coding 服务及 `doubao-seed-2.0-mini`。`--config ./path.json` 指定的文件必须存在。配置文件路径和工作区路径相对启动命令所在目录解析；`--workspace` 优先于文件配置。工作区必须是已存在的可访问目录，会解析为绝对路径，不会改变进程工作目录。文件工具的相对路径从工作区解析。

```json
{
  "provider": "openai",
  "model": "doubao-seed-2.0-mini",
  "apiKeyEnv": "ARK_API_KEY",
  "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "workspace": "./demo",
  "timeoutMs": 60000,
  "maxSteps": 20
}
```

| 字段 | 含义 |
| --- | --- |
| `provider` | 当前仅支持 `openai` 协议适配器，通过 `@ai-sdk/openai` 调用兼容的 Chat Completions 服务；当前服务为火山方舟 |
| `model` | 实际模型 ID，必须支持 function/tool calling；当前配置 `doubao-seed-2.0-mini` |
| `apiKeyEnv` | 密钥的环境变量名，仅引用凭据；不接受 `apiKey` 等明文字段 |
| `baseURL` | 可选，默认 `https://api.openai.com/v1`；必须是无内嵌凭据、查询参数及片段的 HTTP(S) 地址 |
| `workspace` | 默认 `./demo`；CLI 可覆盖 |
| `timeoutMs` | 1–3,600,000ms；每轮独立计时，覆盖该轮的生成与工具循环，超时通过 AbortSignal 中止请求 |
| `maxSteps` | 1–100，默认 20；每轮独立计步，达到上限仍在调用工具时该轮失败，交互模式继续等待输入 |

未知字段、无效类型及越界数值会在网络请求前报错。自动重试关闭，避免鉴权失败反复请求。Ctrl+C 会中止当前请求。

自定义 `baseURL` 的服务必须兼容 OpenAI Chat Completions 及函数调用；仅能返回文本不足以认定工具兼容。项目配置文件不存在时，内置默认值使用 OpenAI 地址、`gpt-4.1-mini-2025-04-14` 和 `OPENAI_API_KEY`；正常启动请保留本项目的方舟配置文件。

2026-11-03 的基础版本曾通过方舟真实模型和 `runtimeInfo` 工具验收，详见 [历史验收记录](docs/verification.md)。当前交互式对话与文件工具的验收项目见 [QA 清单](.scratch/interactive-cli-file-tools/qa-checklist.md)。

## 文件工具与工作区边界

| 工具 | 能力 |
| --- | --- |
| `read_file` | 接收 `path`，读取工作区内文本文件，将内容返回给 Agent |
| `write_file` | 接收 `path` 和 `content`，完整替换目标文件；文件不存在时创建，不自动创建父目录 |
| `runtimeInfo` | 返回工作区绝对路径和本轮运行探针 |

相对路径从配置的工作区解析；绝对路径仅在解析后的目标仍位于工作区内时允许。指向工作区外的符号链接会被拒绝。read_file 和 runtimeInfo 默认直接执行；write_file 默认在独立模型审批通过后执行。固定允许或审批通过均不能放宽文件路径与符号链接边界。文件访问失败会作为工具结果返回给 Agent，让它解释问题或继续处理。

终端实时显示 `[工具] read_file：开始`、`[工具] read_file：成功`、`[工具] read_file：失败` 或 `[工具] read_file：拒绝` 等执行状态，不直接打印工具参数、文件内容或原始异常。一次调用只显示一个终结状态；普通调用失败后，同批后续调用仍会执行，Agent 会收到各次工具结果并决定如何继续。Agent 的最终回答可以按用户要求引用文件内容。

## 工具策略与模型审批

可在配置中添加 `approval`，省略时采用模型审批：

```json
{
  "approval": {
    "mode": "model",
    "timeoutMs": 30000,
    "rules": [
      { "toolName": "read_file", "action": "allow" },
      { "toolName": "write_file", "action": "ask" }
    ]
  }
}
```

`rules` 只精确匹配工具名称，不支持通配符、路径或命令前缀。`allow` 直接执行，`deny` 直接拒绝，`ask` 进入审批。同名规则冲突时 `deny` 优先，其次 `allow`，然后 `ask`；无匹配规则时 read_file、runtimeInfo 默认允许，其他工具默认审批。未知工具或无效参数在审批前拒绝。修改参数或再次调用都需要重新判断，不复用上次批准。

每次模型审批使用独立请求，仅发送专用审查提示词和本次工具名称、完整参数，不发送用户目标、对话历史或文件执行结果，也不给审查模型提供工具。审查只接受 `approve` 或 `deny`，不能核验完整用户意图，不提供操作系统隔离。当前 CLI 只交付 `model` 模式，人工终端模式在后续工单交付。公共 `runAgent` 另提供可等待的 `approvalControl(call, signal)`，返回 `approve` 或 `deny`；固定策略优先，控制接口与仅用于观察的 `onToolEvent` 分离，答复不改变已批准的参数。

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

审批独立上限 `approval.timeoutMs` 默认 30 秒，范围为 1–3,600,000 毫秒，同时受整轮 `timeoutMs` 剩余时限与取消约束，不自动重试。等待期间不会启动操作或显示工具开始；明确拒绝显示“拒绝”，以 `PERMISSION_DENIED` 工具结果回传，其他普通调用继续。审查超时、不可用或响应无效产生用户可见的 `APPROVAL_ERROR` 并停止本轮，不再执行后续工具或请求主模型。此前副作用保留，失败轮不保存，CLI 仍可接收新消息；Ctrl+C 或 SIGTERM 取消并退出。

普通进度和日志不输出审批参数、结果或原始异常。观察回调失败只输出诊断，不替代审批也不改变决定。常规验证使用本地模型夹具与假凭据；自动测试不能代替最终人工 QA。

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
| 130 | `CANCELLED` | 用户取消 |

`pnpm test` 使用本地 HTTP fixture 运行真正的 SDK/provider 和编译后的 CLI，覆盖多轮对话、会话续接、成功保存、失败恢复、文件读写、越界拒绝、缺失父目录、冒烟成功、步数上限、超时和取消，并检查配置校验。这些测试使用假凭据，不需要真实 API key。

本地 fixture 需要监听 `127.0.0.1` 端口；真实终端取消测试在 macOS/Linux 上使用系统 `script` 和 `/bin/sh`，Windows 跳过该组测试。受限沙箱需允许本地端口与伪终端访问。完整人工验收步骤见 [QA 清单](.scratch/interactive-cli-file-tools/qa-checklist.md)，真实服务验收需单独执行上述命令。

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

仓库的 GitHub Actions 支持 Issue 实现、PR 审查与反馈修改、分支更新、带人工 QA 的拆票与逐轮实现、依赖排队及架构审查。维护者给父 Issue 添加 `agent:implement` 后，临时 Ubuntu Runner 通过 Sandcastle 的 `codex()` 实现并验证代码，创建草稿 PR 后自动审查，由人决定合并。`ready-for-agent` 仅表示准备状态；拆票经 `agent:publish-tickets` 确认才发布，人工 QA 不进入自动实现。方法来自仓库 `.agents/skills/` 的固定版本，CI 不临时下载。

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

可用 `pnpm dev --workspace ./.demo-workspace` 启动 Agent，然后输入“读取 src/checkout.ts 和 regression/discount.test.ts，修复金额恰好为 100 时未打折的问题”。Agent 可以读取和修改文件；测试命令需由用户在该副本目录执行。
