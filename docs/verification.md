# 基础 CLI 验收记录

## Issue #101 权限策略文档同步与回归验收

日期：2026-11-10。分支 `agent/parent-92`，基于前序子任务提交 `f4d5a6b`。本 Issue 同步 README、术语表、文件权限 ADR 和本地 QA 指南；没有修改运行时代码或测试。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过：TypeScript 类型检查、构建；Vitest 30 个测试文件、407 项测试全部通过（测试运行 229.58 秒） |
| `pnpm demo:test` | 通过：3 项演示回归测试，0 失败 |
| `git diff --check` | 通过：文档补丁无空白错误 |
| 人工权限 QA | 待执行；自动化结果不代表人工验收完成 |

回归覆盖分层 settings、文件读取与写入、Glob/Grep、Bash、MCP、审批上下文、Explore/子 Agent、会话恢复及演示项目。人工验收步骤见[本地 QA 指南](qa-tool-capabilities.md)“权限规则回归与人工 QA”。本次没有运行真实模型服务，也没有执行该人工清单；此前已有副作用保留、失败隔离、取消和 MCP 延期专项状态继续按本文对应记录，不因本轮自动检查而改变。

## 工具权限、宿主 Bash、基础 MCP 与摘要组合验证

日期：2026-11-05。子任务 #16，基于本轮输入版本 `e56ae3f` 叠加工作区修改；Node.js 24.22.2、pnpm 9.12.3，Linux 临时 Runner。本轮只交付组合验证和人工验收准备，最终人工 QA #17 仍待人执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过：严格类型检查、构建、21 个测试文件共 311 项测试 |
| `pnpm demo:test` | 通过：3 项基础测试 |
| 编译后 CLI 组合测试 | 通过：混合批次顺序、调用 ID、普通失败隔离；文件和远端副作用后审批故障；轮内工具增长后的摘要成功、失败与空响应；预算及配对故障停止后继续输入 |
| 独立 QA 启动入口 | 通过：真实子进程生成配置、旧格式历史和受控命令，CLI 完成摘要及跨进程续聊，并在下轮发现新版 MCP schema；历史权限保持 0600 |
| 人工审批与真实进程 | 通过：人工等待跨过原截止时间后仍能批准，后续整轮超时或 SIGTERM 终止 Bash 与子进程；已有写入保留，后续调用及延迟标记不发生 |
| 文档中的独立启动命令 | 已实际执行 `pnpm exec tsx tests/helpers/local-qa-fixture.ts --directory <全新目录> --scenario normal`，收到 `QA_READY`，`status` 显示计数，`exit` 正常关闭 |
| `git diff --check` | 通过 |

新增 12 项测试：`capability-integration.test.ts` 9 项、`local-qa-launcher.test.ts` 1 项、`human-approval.test.ts` 2 项。组合夹具的初始测试在入口缺失及故障场景未提供时失败，补齐后通过。测试使用本地模型、两个真实 Streamable HTTP MCP 夹具和假认证标记，不依赖真实账号或在线服务；检查模型请求、历史和普通日志不含连接器认证值。

复现、配置字段与人工场景见 [本地 QA 指南](qa-tool-capabilities.md)。未运行故意失败的 `demo:bug` 或真实模型 `smoke`。MCP 独立断连、超时、取消及结果未知专项按需求评论延期；自动测试和代码审查不代表这些场景或最终人工 QA 已通过。没有提交、发布或关闭任务，后续审查由外层 workflow 负责。

## 工具执行框架最终审查修复

日期：2026-11-04。基于集成分支 `feat/tool-execution-framework` 的 `22dd4ae`，在独立工作树执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过：类型检查、构建及 5 个测试文件共 69 项测试 |
| 编译后 CLI + 本地 HTTP fixture | 通过：`maxSteps=1` 时 `finish_reason=stop` 且响应包含文本和实际工具调用，首轮报告 `STEP_LIMIT`、不发起额外模型请求、不保存失败轮，随后 CLI 可接收并保存下一轮 |
| `git diff --check becf2db...HEAD` | 通过 |
| 真实模型 `pnpm smoke` | 命令保留；本次未调用真实模型服务 |

完整发现与修复说明见[工具执行框架审查记录](../.scratch/tool-execution-framework/review.md)。

## 工具执行框架 04 回归验收

日期：2026-11-04。基于集成分支 `b2685c6`，在独立工作树执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过：类型检查、构建及 5 个测试文件共 65 项测试 |
| 编译后 CLI + 本地 HTTP fixture | 通过：read/write 缺字段、字段类型错误、空 path、无效 JSON；runtimeInfo 额外字段兼容；整轮超时后继续下一轮、达到 maxSteps 后停止当前轮、模型请求失败后不保存失败轮；成功写入后 provider 错误不回滚文件副作用；既有工作区边界、符号链接、缺失父目录与 SIGINT 回归仍通过 |
| 损坏 provider stream 回归 | 通过：有效写入调用后出现 SDK error part 时立即终止该轮，工具副作用未发生、没有下一次模型请求、失败轮次未保存，CLI 可继续下一轮 |
| 公共 `runAgent` 定向测试 | 通过：异步执行事件通知 rejection 被隔离且不阻塞后续调用；首个工具开始后取消不执行同批排队工具或发起下一次模型请求。CLI seam 无法稳定注入异步通知失败或工具开始时的同步取消信号 |
| 真实模型 `pnpm smoke` | 命令保留；本次未调用真实模型服务 |

复现命令：

```sh
pnpm check
git diff --check
```

本地模型服务均由测试 fixture 提供，不代表真实 provider 的工具兼容性验证。

日期：2026-11-03。运行时：Node.js 24.22.2，pnpm 9.12.3，macOS arm64。

| 检查 | 结果 |
| --- | --- |
| pnpm 精确依赖安装及严格 peer 校验 | 通过，主项目和 demo 均有 lockfile |
| `pnpm check` | 通过：严格类型检查、ESM 构建、36 个测试 |
| 全新临时副本，清空环境变量，`pnpm install --frozen-lockfile --offline`、`pnpm check` | 通过，依赖从本机 pnpm store 导入，无现有 node_modules/dist |
| 编译后 CLI 缺少凭据 | 明确记录 CONFIG_ERROR，退出 2 |
| 本地 HTTP fixture：模型文本回答、工具执行与结果回传 | 通过，使用实际 ai SDK 和 OpenAI provider，不替换 Agent 实现 |
| 本地 HTTP fixture：工具选择被忽略、结果未被模型使用 | 明确退出 6 |
| 本地 HTTP fixture：总超时、401/403、429、步数上限、截断回答、SIGINT | 通过，对应非零退出码和终态日志 |
| `pnpm dev --help` | 通过 |
| 默认 Node.js 26.5.0 终端直接执行 `pnpm dev --workspace ./demo "介绍你的能力"` | 通过：`.npmrc` 自动选择 Node.js 24.22.2，真实模型回答退出 0，1807ms |
| 默认 Node.js 26.5.0 终端执行 `pnpm check` | 通过：自动使用锁定运行时，类型检查、构建和 36 个测试均通过 |
| `pnpm demo:test` | 3 个基础测试通过 |
| `pnpm demo:bug` | 按预期失败：100 !== 90 |
| `pnpm demo:init` | 已创建独立 `.demo-workspace/`，起始提交 `0a75d5fcd99c8109e30d6a59da77f0ddacaf81b8`，标签 `demo-start` |
| 独立副本 frozen 安装、类型检查及基础测试 | 通过，Git 工作区保持干净 |
| 真实模型成功回答 | 通过：方舟 `doubao-seed-2.0-mini`，退出 0，4805ms |
| 真实 provider 工具兼容冒烟 | 通过：2 步、1 次工具执行、退出 0，2187ms，`toolSmokePassed: true` |
| 当前配置缺失凭据 | 通过：临时引用空环境变量，CONFIG_ERROR，退出 2 |
| 当前服务鉴权失败 | 通过：使用独立无效测试凭据，AUTH_ERROR，退出 3，187ms |
| 当前配置超时 | 通过：临时设置总时限 1ms，TIMEOUT，退出 4，29ms（含配置及 SDK 初始化） |

真实验收于 2026-11-03 18:38–18:39（Asia/Shanghai）完成，使用 `https://ark.cn-beijing.volces.com/api/coding/v3`，通过 OpenAI 兼容 Chat Completions 协议调用。密钥仅存入被 Git 忽略的 `.env`，文件权限 0600；扫描确认工程可分发文件不包含该密钥。

成功回答的 run ID 为 `35118e14-0655-4b16-ad66-8d7d24ae6b05`；工具冒烟的 run ID 为 `e65ab0cd-7bc3-4486-8cfc-cb2b5544adef`。工具返回的随机探针未预置于 prompt，模型最终回答包含相同探针，确认工具执行及结果回传可用。

错误路径使用独立临时配置，没有改动正式凭据。1ms 超时验证总 deadline 的中止行为；服务挂起时的超时另由本地 HTTP fixture 验证。

本机已配置 `ARK_API_KEY`。其他终端在根目录 `.env` 填入自己的同名凭据后，用项目锁定的 Node.js/pnpm 执行：

```sh
pnpm build
pnpm exec node dist/cli.js --workspace ./demo "介绍你的能力"
pnpm smoke
```

正常回答须非空、退出 0。工具验收须退出 0，且终态日志包含 `toolSmokePassed: true`。配置其他服务时，修改工作区 `.agent/settings.json` 的 `baseURL`、`model` 和 `apiKeyEnv`，重新运行上述验收。
