# GitHub Actions 与 Codex 订阅

工作流使用私有仓库的 GitHub Ubuntu Runner，通过 Sandcastle 的 `codex()` 运行订阅账号，不需要 OpenAI API Key。已迁移 course-video-manager 的 Issue 实现、PR 审查与反馈修改、分支更新、PRD 拆分及逐轮实现、依赖排队和架构审查；所有模型任务共用订阅登录态。

## 首次配置

### 1. 把工作流合入默认分支

提交本地配置并合入 GitHub 的 `main`。Issue 标签事件使用默认分支上的 workflow；只有本地文件不会启动云端任务。合并后手动运行一次 `Setup Agent Labels`，补齐所有标签。准备执行任务时也会自动补齐缺失标签。

### 2. 配置订阅登录文件

在项目目录为 CI 单独登录一次，跟随浏览器提示使用你的订阅账号：

```bash
CODEX_HOME="$HOME/.codex-qhy-ci" pnpm exec codex -c 'cli_auth_credentials_store="file"' login
```

将专用登录文件通过标准输入保存为仓库 Secret：

```bash
gh secret set CODEX_AUTH_JSON \
  --repo kylnglgjk7979655-create/qhy-coding-agent-ts \
  < "$HOME/.codex-qhy-ci/auth.json"
```

`gh` 需要先登录 GitHub。也可在仓库 Settings → Secrets and variables → Actions 中添加 `CODEX_AUTH_JSON`，值为这个专用 `auth.json` 的完整内容。文件需要 `auth_mode: "chatgpt"` 及 access token、refresh token。

上传后，这份专用登录交给 CI 使用；不要再用这个专用目录并行运行本机 Codex。你平时的 Codex 登录保持独立。文件不提交到 git、不粘贴到 Issue 或聊天。

### 3. 配置登录态回存 Token

打开 [GitHub Fine-grained PAT 创建页面](https://github.com/settings/personal-access-tokens/new)：

1. Repository access 选择 Only select repositories，仅选择本仓库。
2. Repository permissions 中设置 **Secrets → Read and write**。
3. 创建 Token 后，在仓库 Actions Secrets 新增 **`CODEX_AUTH_STORE_PAT`**，值为该 Token。

这个 Token 用于获取 GitHub 的 Secret 加密公钥、检查版本、保存刷新后的 `CODEX_AUTH_JSON`。它不授予代码推送权限，也不会传给运行 Codex 的 job。Token 到期后更新此 Secret。

### 4. 配置 PR 发布权限

在 Settings → Actions → General → Workflow permissions 勾选 **Allow GitHub Actions to create and approve pull requests**。各 job 已声明需要的权限，默认工作流权限可保持只读。除用 `AGENT_PAT` 创建 PR 外，发布 API 使用 job 的 `GITHUB_TOKEN`；审查只发布 COMMENT，不自动批准或合并。

可选配置 **`AGENT_PAT`**：fine-grained PAT 限制到本仓库，授予 Contents 读写和 Pull requests 读写；允许 Agent 修改 workflow 文件时另需 Workflows 写权限。该 PAT 用于推送代码和创建 PR，使 PR 检查由仓库成员触发；它不参与订阅认证回存。未配置时仍可通过 `GITHUB_TOKEN` 推送普通代码、创建 PR 和接续工作流，但 GitHub 可能要求先批准 Bot 创建的 PR 工作流；修改 workflow 文件会被 GitHub 拒绝。

代码变更发布后会通过 `workflow_dispatch` 显式启动 PR 分支的 `Check`，因此普通任务不必为了 CI 触发而额外配置 PAT。

## 日常使用

创建 GitHub Issue，写清复现步骤或需求、期望结果、验收条件。添加 **`agent:implement`** 标签启动。`ready-for-agent` 仅表示准备完成，不触发执行。

然后在 Actions → Codex Implement Issue 查看进度。也可在该 workflow 的 Run workflow 中填写 Issue 编号手动启动。成功后 Issue 会出现草稿 PR 链接，并自动接续 Codex 审查。审查使用两个独立新会话分别检查规范与需求，再修复并发布 COMMENT；完成后将草稿标记为 Ready，由人决定合并。普通 Issue 的 `Closes #编号` 在合并时关闭；含人工 QA 的父规格只关联，由人确认关闭。

| Secret / Variable | 是否必需 | 用途 |
| --- | --- | --- |
| Secret `CODEX_AUTH_JSON` | 是 | CI 专用的 Codex 订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 是 | 自动回存刷新后的登录态，Secrets 读写权限 |
| Secret `AGENT_PAT` | 可选 | 代码推送和 PR 创建；需要 Contents、Pull requests 读写权限，允许修改 workflow 时另需 Workflows 写权限 |
| Variable `CODEX_MODEL` | 可选 | 显式指定模型；未设置时会自动选择 `codex debug models` 返回的首个可用模型（探测失败回退 `gpt-6-luna`） |

云端工作流不读取 `OPENAI_API_KEY`。演示 CLI 的 `agent.config.json`、第三方 baseURL 和 `.env` 与此订阅认证分开。

## 任务入口与使用顺序

| 操作 | 入口 | 行为 |
| --- | --- | --- |
| 实现普通需求 | Issue 添加 `agent:implement` | 从默认分支实现，验证后创建草稿 PR，自动接续审查 |
| 审查 PR | PR 添加 `agent:review` | 按仓库规范、关联 Issue 与已关闭子任务审查；可修复明确问题，发布行内评论及摘要 |
| 根据反馈修改 | PR 留下反馈后添加 `agent:implement` | 读取顶层评论、review 摘要和未解决 threads，修改并回复有关 thread |
| 更新 PR 分支 | PR 添加 `agent:update-branch` | 合并 PR 基准分支，必要时让 Codex 解决冲突；创建保留两个父提交的 merge commit |
| 生成拆票计划 | 父 Issue 添加 `agent:to-issues` | 加载 to-tickets，只读生成实现切片和依赖，写入待审批评论 |
| 确认发布工单 | 父 Issue 添加 `agent:publish-tickets` | 按已保存计划创建原生子 Issue、执行角色及依赖；不调用模型或启动实现 |
| 逐轮实现 PRD | 含子 Issue 的父 Issue 添加 `agent:implement` | 自动选择 PRD 模式，每轮实现一个依赖已完成的 Agent 子任务，共用 `codex/prd-编号` 分支及一个草稿 PR |
| 等待依赖 | 根 Issue 配置原生 GitHub `blocked by` 关系并添加 `agent:queued` | 依赖完成后每次只派发一个符合条件的任务 |
| 架构审查 | Actions → Codex Architecture Review，或工作日 UTC 09:00（北京时间 17:00） | 只读代码及历史提案，最多提出一个新 PRD，标记 `source:architecture-review`；10个开放提案时暂停 |

各模型任务都有手动入口：在 Actions 选对应工作流，填写 `issue_number` 或 `pr_number`。`Codex Implement PRD` 是逐轮实现的接续与恢复入口；Issue 标签仍由 `Codex Implement Issue` 自动识别。`Codex Subscription Task` 是内部复用流程，不直接手动运行。

PRD 建议顺序：写父 Issue → `agent:to-issues` → 检查评论中的完整计划 → `agent:publish-tickets` → 检查生成的子任务 → 给父 Issue 添加 `agent:implement` → 按真实依赖串行实现 → 自动审查同一个 PR → 人工合并。实现子 Issue 在代码推送、检查和 PR 发布成功后关闭；已有 Human QA 任务保持开放，由人执行并记录测试版本和结果。有 QA 的 PR 使用 `Refs #父规格`，父规格由人确认关闭。只支持扁平子任务，不直接给子 Issue 添加实现标签。

手动生成或发布计划使用 Actions → Codex Plan and Publish Tickets：填写父 Issue 编号，生成计划时保持 `publish_approved=false`；检查计划后再勾选该选项启动新的运行。发布阶段不需要恢复订阅登录；失败时重新添加 `agent:publish-tickets` 可复用原计划和已创建的 Issue、挂接及依赖。不要通过重跑旧规划来覆盖发布中的计划。

反馈不会因为新评论自动运行；由维护者通过标签决定何时启动。审查可不修改代码，反馈修改可只回复；普通 Issue 实现没有代码变更则失败。PRD 子任务已经满足验收条件时允许无新增修改，但必须明确确认完成，外层仍会验证。

依赖队列使用 GitHub 原生关系，不解析正文的“依赖 #N”。所有阻塞项都必须以完成状态关闭；`not_planned` 不视为完成。只调度根 Issue，跳过人工任务、进行中及失败阻塞项；一次只派发一个，结束后继续检查队列。添加排队标签后，可手动运行 `Codex Promote Queued` 启动调度；Issue 完成关闭也会触发。自动链路失败会停止推进，修复后重新触发对应任务。

## 登录态怎样维护

GitHub 临时 Runner 每轮结束都会销毁，因此每轮需要恢复、运行、保存。[OpenAI 官方说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求保存 Codex 自己刷新后的登录文件，并串行使用同一份认证。

所有模型入口调用 `codex-task.yml`，共用五阶段流程：

1. `prepare` 验证私有仓库及触发者写权限，读取需求、PR 反馈及关系，锁定工作 SHA 和控制脚本 SHA，获取 Secret 公钥和版本。PR 任务拒绝 fork、关闭及已合并的 PR。
2. `generate` 从可信控制脚本创建独立 worktree，在其中运行 Sandcastle/Codex。随后加密刷新后的登录态并删除明文，再独立运行 `pnpm check` 与 `pnpm demo:test`、校验结构化结果并导出补丁。拆分与架构任务只校验未改代码。
3. `persist-auth` 在独立 Runner 上把加密登录态写回 `CODEX_AUTH_JSON`，不执行 Agent 生成的代码、不解密认证包。生成失败后若已有认证包，仍尝试保存刷新结果。
4. `publish` 只有在生成验证及认证回存成功后执行，重新检查 PR/Issue 状态、按原 SHA 应用补丁，提交并普通推送。分支前进则拒绝覆盖。再发布 PR、评论、子 Issue 或架构提案。
5. `finish` 清理进行中标签，发布结果；失败标记 `agent:blocked`。成功后通过 `workflow_dispatch` 接续下个子任务或审查，链路结束后检查依赖队列。

运行 Codex 的 job 没有仓库写入 Token 或 Secret 写入 Token。跨 job 只传递公钥加密后的认证包，明文 `auth.json` 不进入 artifacts。恢复步骤注册凭据日志遮罩。Sandcastle 使用 `noSandbox()` 在临时 Runner 执行，独立 worktree 是代码目录分离，不提供进程隔离；仓库维护者必须信任任务及仓库代码。

自动接续及代码变更后的 `Check` 使用带 `actions: write` 权限的 job `GITHUB_TOKEN` 发起 `workflow_dispatch`，无需额外 PAT 来触发标签事件或 CI。Agent 执行 job 自身也始终先验证代码。

所有任务及队列调度共用 `codex-subscription-仓库名` 并发组，避免并发刷新同一登录。GitHub 并发组只有一个待运行槽，不是完整 FIFO 队列；请不要同时手动启动多个模型任务。批量需求使用 `agent:queued`，必要时手动运行队列工作流恢复调度。排队后凭据更新、或运行期间凭据被替换时，工作流拒绝使用或覆盖旧版本；重新触发新的运行，不要重跑旧运行。

## 失败和限制

查看 Issue / PR 评论的 Actions 链接。处理原因后重新添加对应标签，或手动启动新的运行。认证回存失败、工作流被取消时，可能需要重新登录并更新 `CODEX_AUTH_JSON`。仓库重新公开后工作流拒绝运行。准备阶段在完成权限检查与任务校验前失败时，只在 Actions 中报告，不修改 Issue 或 PR 状态。

若出现 `model is not supported when using Codex with a ChatGPT account`，设置仓库 Variable `CODEX_MODEL` 为该订阅可用的模型；错误中的模型名才是排查线索。Codex 的 stdout 错误现在会额外输出，避免仅看到 `Reading prompt from stdin...`。

每次启动 Codex 时日志显示选用的模型，结束时显示该会话最后一次模型调用的输入 token 数及可用时的上下文上限。审查的三个独立会话分别报告；若会话记录没有用量，日志会显示不可用。

Agent 最长运行 45 分钟，连续无输出 5 分钟失败；生成 job 超时 60 分钟。没有自动批准、自动合并。架构审查每个工作日运行一次，会消耗 Actions 时间与 Codex 订阅用量；不需要时可在 Actions 中禁用该 workflow。

任务显式读取仓库 `.agents/skills/` 的固定版本：implement-spec、tdd、diagnosing-bugs、codebase-design、code-review、pr 和 to-tickets。to-spec 从本地讨论整理规格，发布到仓库 GitHub Issues。原文及引用文件完整提交，来源与文件校验值见 `.agents/skills/UPSTREAM.json`；本地和云端不自动下载或更新。implement-spec 的云端执行按任务依赖串行推进，由 workflow 管理分支及发布。

具体适配见 [skill-execution.md](skill-execution.md)。结构化结果不合法时本轮失败，不自动重复有副作用的任务。

## 本地运行

本机默认复用 `codex login` 的 ChatGPT 登录。先准备 Issue JSON：

```json
{"number":42,"title":"修复空输入错误","body":"复现步骤和验收条件","url":"https://github.com/owner/repo/issues/42","comments":[]}
```

预览提示词，不调用模型：

```bash
ISSUE_CONTEXT_PATH=/tmp/issue.json pnpm agent:implement --dry-run
```

在独立副本中实际运行：

```bash
ALLOW_HOST_EXECUTION=1 ISSUE_CONTEXT_PATH=/tmp/issue.json pnpm agent:implement
```

本地运行不会自动推送或创建 PR。只有显式设置 `CODEX_AUTH_MODE=api-key` 和 `CODEX_API_KEY` 才使用 API 认证。
