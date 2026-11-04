# qhy-coding-agent-ts

基于 AI SDK 7 的基础 CLI Agent：输入需求，得到真实模型回答。通过 `ToolLoopAgent.stream()` 流式运行工具循环，显式使用 `stopWhen: isStepCount(maxSteps)`，默认 20 步。会话历史保存在当前目录 `.agent/conversations/`，支持用 conversation ID 接续对话。目前提供一个无副作用的 `runtimeInfo` 工具，不具备读写文件或执行 shell 的能力。

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
pnpm exec node dist/cli.js --workspace ./demo "介绍你的能力"
```

首次调用会创建会话；`run.started` 和 `run.finished` JSON 日志包含 `conversationId`。后续传入该 ID 可加载历史消息继续对话：

```sh
pnpm exec node dist/cli.js --conversation-id "$CONVERSATION_ID" "继续刚才的话题"
```

会话仅在模型返回完整回答后保存。历史文件按 conversation ID 区分并原子更新，目录权限设为仅当前用户可访问。

不需要构建的开发入口：

```sh
pnpm dev --workspace ./demo "介绍你的能力"
```

如环境没有 pnpm，可使用 [pnpm 官方安装方法](https://pnpm.io/installation)安装 **9.12.3**。工程全部依赖安装与执行均使用 pnpm。`pnpm dev`、`pnpm build`、`pnpm test` 和 `pnpm exec node` 自动使用锁定的 Node.js；终端直接执行 `node` 仍使用系统版本。如需直接运行 `node dist/cli.js`，先使用 nvm/fnm 按 `.nvmrc` 或 `.node-version` 切换到 Node.js 24.22.2。

## 模型及运行配置

默认读取当前目录的 `agent.config.json`，项目已配置火山方舟 Coding 服务及 `doubao-seed-2.0-mini`。`--config ./path.json` 指定的文件必须存在。所有相对路径均相对启动命令所在目录；`--workspace` 优先于文件配置。工作区必须是已存在的可访问目录，会解析为绝对路径，不会改变进程工作目录。

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
| `timeoutMs` | 1–3,600,000ms；覆盖整个生成与工具循环，超时通过 AbortSignal 中止请求 |
| `maxSteps` | 1–100，默认 20；达到上限仍在调用工具时以失败状态退出 |

未知字段、无效类型及越界数值会在网络请求前报错。自动重试关闭，避免鉴权失败反复请求。Ctrl+C 会中止当前请求。

自定义 `baseURL` 的服务必须兼容 OpenAI Chat Completions 及函数调用；仅能返回文本不足以认定工具兼容。项目配置文件不存在时，内置默认值使用 OpenAI 地址、`gpt-4.1-mini-2025-04-14` 和 `OPENAI_API_KEY`；正常启动请保留本项目的方舟配置文件。

当前方舟配置已通过真实模型回答和无副作用工具调用验收，详见 [验收记录](docs/verification.md)。

## 真实模型与工具验收

配置凭据后执行，都会调用真实服务并产生相应 API 用量：

```sh
pnpm exec node dist/cli.js --workspace ./demo "介绍你的能力"
pnpm smoke
```

第一条应输出非空完整回答并以 0 退出。第二条等价于 `--smoke-tool`：首步强制调用 `runtimeInfo`，执行后将工具结果传回模型，要求最终回答包含工具生成的随机探针。只有观察到实际工具执行、结果回传及最终回答使用该探针，才记录 `toolSmokePassed: true` 并退出 0。探针不会预先出现在 prompt 中。工具只返回配置中的工作区路径与探针，不读取或写入文件。

```sh
pnpm exec node dist/cli.js --workspace ./demo --smoke-tool
```

工具冒烟至少需要两步。若服务忽略工具选择、没有执行工具或未使用结果，会以 `TOOL_COMPATIBILITY_ERROR` 退出。变更模型、provider 或地址后应重新执行真实冒烟。

## 日志与失败状态

stdout 流式输出回答；stderr 输出每行一个 JSON 事件，可独立重定向：

```sh
pnpm exec node dist/cli.js --workspace ./demo "介绍你的能力" > answer.txt 2> run.jsonl
```

`run.started` 记录 run ID、模型配置、工作区及请求状态；`run.finished` 复用 run ID，记录成功/失败、总耗时、步数、工具调用次数和 token 用量。配置错误也有带 run ID 的终态记录。日志不包含密钥、用户需求或原始 provider 错误响应。计时包含参数与配置解析。

| 退出码 | 错误码 | 处理建议 |
| --- | --- | --- |
| 0 | 成功 | 完整回答已输出 |
| 1 | `INTERNAL_ERROR` | 检查服务协议兼容性 |
| 2 | `CONFIG_ERROR` | 补齐凭据、修正配置、工作区或参数 |
| 3 | `AUTH_ERROR` | HTTP 401/403；检查密钥与服务权限 |
| 4 | `TIMEOUT` | 总时限或 HTTP 408/504；检查网络或调整时限 |
| 5 | `PROVIDER_ERROR` | 网络、配额、HTTP 错误，或回答为空/被截断 |
| 6 | `TOOL_COMPATIBILITY_ERROR` | 工具冒烟未通过 |
| 7 | `STEP_LIMIT` | 步数用尽，尚未完成回答 |
| 130 | `CANCELLED` | 用户取消 |

`pnpm test` 在本机 HTTP fixture 上运行真正的 SDK/provider 和编译后的 CLI，覆盖成功回答、工具往返、工具冒烟拒绝、总超时、401/403、429 不重试、步数上限、截断回答、缺失配置、`.env` 读取和取消。这些测试不需要 API key；真实服务验收须运行上面的两条命令。

## 开发命令与版本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev ...` | tsx 执行 TypeScript CLI |
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

基础 Agent 不会自动读取此代码；在后续加入文件和命令工具后，可用这个仓库验证定位、修复和测试能力。
