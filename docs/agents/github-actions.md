# GitHub Actions 与 Codex 订阅

工作流使用私有仓库的 GitHub Ubuntu Runner，通过 Sandcastle 的 `codex()` 运行订阅账号，不需要 OpenAI API Key。已迁移 course-video-manager 的 Issue 实现、PR 审查与反馈修改、分支更新、PRD 拆分、子任务独立实现、依赖晋级和架构审查；模型任务通过独立认证槽位控制并发；默认沿用单份订阅登录态。

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

然后在 Actions → Codex Implement Issue 查看进度。也可在该 workflow 的 Run workflow 中填写 Issue 编号手动启动。功能使用 `agent:implement`，缺陷使用 `agent:bugfix`；设计方案使用 `agent:code-design`。实现成功后 Issue 会出现草稿 PR 链接，并自动接续 Codex 审查。设计只发布方案评论，不创建 PR 或修改代码。审查使用两个独立新会话分别检查规范与需求，再修复并发布 COMMENT；完成后将草稿标记为 Ready，由人决定合并。普通 Issue 和子 Issue 的 `Closes #编号` 在 PR 合并时关闭；父规格只关联，由人最终确认关闭。

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
| 修复缺陷 | Issue 添加 `agent:bugfix` | 复现、诊断、回归测试及修复，验证后创建 PR |
| 设计方案 | Issue 添加 `agent:code-design` | 只读分析，方案发布到原 Issue 评论，不创建 PR |
| 审查 PR | PR 添加 `agent:review` | 按仓库规范、关联 Issue 与已关闭子任务审查；可修复明确问题，发布行内评论及摘要 |
| 根据反馈修改 | PR 留下反馈后添加 `agent:implement` | 读取顶层评论、review 摘要和未解决 threads，修改并回复有关 thread |
| 更新 PR 分支 | PR 添加 `agent:update-branch` | 合并 PR 基准分支，必要时让 Codex 解决冲突；创建保留两个父提交的 merge commit |
| 生成拆票计划 | 父 Issue 添加 `agent:to-issues` | 使用完整拆票 prompt，只读生成实现切片和依赖，写入待审批评论 |
| 确认发布工单 | 父 Issue 添加 `agent:publish-tickets` | 按已保存计划创建原生子 Issue、执行角色及依赖；不调用模型或启动实现 |
| 实现父规格 | 含子 Issue 的父 Issue 添加 `agent:implement` | 全部 Agent 子任务排队，就绪节点按认证容量并行，各自创建分支和 PR |
| 等待依赖 | Issue 或子 Issue 配置原生 GitHub `blocked by` 并添加 `agent:queued` | 依赖完成后晋级全部符合条件且有空闲槽位的任务 |
| 架构审查 | Actions → Codex Architecture Review，或工作日 UTC 09:00（北京时间 17:00） | 只读代码及历史提案，最多提出一个新 PRD，标记 `source:architecture-review`；10个开放提案时暂停 |

各模型任务都有手动入口：在 Actions 选对应工作流，填写 `issue_number` 或 `pr_number`。`Codex Implement PRD` 是父规格授权子任务队列的恢复入口；Issue 标签由 `Codex Implement Issue` 识别。`Codex Task Router` 和 `Codex Subscription Execution` 是内部复用流程，不直接手动运行。

PRD 建议顺序：写父 Issue → `agent:to-issues` → 检查计划 → `agent:publish-tickets` → 检查子任务及原生依赖 → 给父规格添加 `agent:implement`。所有开放 Agent 子任务加入队列；无依赖或依赖已完成的节点按空闲槽位启动。每个子任务使用独立 `codex/issue-编号-运行号-尝试号` 分支及一个草稿 PR，验证后接续独立审查，人决定合并。PR 合并关闭当前子 Issue，才释放依赖它的节点，确保下游启动时默认分支包含前置代码。父规格及人工 QA 保持开放，由人最终验收。

当前仍只支持一层子任务。`Codex Implement PRD` 保留为父规格授权队列的恢复入口，不再调用模型串行写共用分支。若旧的 `codex/prd-编号` PR 仍开放，先合并或人工迁移，工作流拒绝悄悄切换执行方式以免重复实施。旧 PR 已关闭但未合并时，也需要先核对旧流程已经关闭的子任务和未合入代码。

手动生成或发布计划使用 Actions → Codex Plan and Publish Tickets：填写父 Issue 编号，生成计划时保持 `publish_approved=false`；检查计划后再勾选该选项启动新的运行。发布阶段不需要恢复订阅登录；失败时重新添加 `agent:publish-tickets` 可复用原计划和已创建的 Issue、挂接及依赖。不要通过重跑旧规划来覆盖发布中的计划。

反馈不会因为新评论自动运行；由维护者通过标签决定何时启动。审查可不修改代码，反馈修改可只回复；功能或缺陷实现没有代码变更则失败。设计方案可在没有修改的情况下交付，输出必须通过设计结果校验。所有修改阶段都必须明确 completed:true。

依赖晋级采用 Matt 的 `agent-promote-queued.yml` 机制，并扩展对子 Issue 的支持：关闭事件通过 `blocking` 找出下游，逐一检查全部 `blockedBy`；所有阻塞项须以完成状态关闭，`not_planned` 不算完成。排队标签表示执行授权，人工任务、进行中及失败任务不会被自动领取。发布代码、创建 PR 或 CR 成功均不会提前关闭子任务；正常通过 PR 合并完成关闭。

首次启动父规格、添加 queued、Issue 完成关闭、任务链结束都会启动或唤醒扫描；每 15 分钟定时扫描补齐零依赖节点和遗漏事件。依赖解除的事件不会等待无关任务完成。自动派发前预留独立认证槽位，先加 dispatching 再移除 queued；派发失败恢复队列，其余就绪节点仍可运行。自动接续使用 workflow_dispatch，不要求 PAT 触发标签事件。

## 登录态怎样维护

GitHub 临时 Runner 每轮结束都会销毁，因此每轮需要恢复、运行、保存。[OpenAI 官方说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求保存 Codex 自己刷新后的登录文件，并串行使用同一份认证。

所有模型入口通过 `codex-task.yml` 路由到认证槽位，随后调用 `codex-execute.yml`，执行五阶段流程：

1. `prepare` 验证私有仓库及触发者写权限，读取需求、PR 反馈及关系，锁定工作 SHA 和控制脚本 SHA，获取 Secret 公钥和版本。PR 任务拒绝 fork、关闭及已合并的 PR。
2. `generate` 从可信控制脚本创建独立 worktree，加载完整任务 prompt，在其中运行 Sandcastle/Codex。随后加密刷新后的登录态并删除明文，再独立运行 `pnpm check` 与 `pnpm demo:test`、校验结构化结果并导出补丁。拆分、设计和架构任务只校验未改代码。
3. `persist-auth` 在独立 Runner 上把加密登录态写回本轮所选认证槽位 Secret，不执行 Agent 生成的代码、不解密认证包。生成失败后若已有认证包，仍尝试保存刷新结果。
4. `publish` 只有在生成验证及认证回存成功后执行，重新检查 PR/Issue 状态、按原 SHA 应用补丁，提交并普通推送。分支前进则拒绝覆盖。再发布 PR、评论、子 Issue 或架构提案。
5. `finish` 清理进行中标签，发布结果；失败标记 `agent:blocked`。成功后通过 `workflow_dispatch` 接续审查，链路结束释放槽位并检查依赖队列。

运行 Codex 的 job 没有仓库写入 Token 或 Secret 写入 Token。跨 job 只传递公钥加密后的认证包，明文 `auth.json` 不进入 artifacts。恢复步骤注册凭据日志遮罩。Sandcastle 使用 `noSandbox()` 在临时 Runner 执行，独立 worktree 是代码目录分离，不提供进程隔离；仓库维护者必须信任任务及仓库代码。

自动接续及代码变更后的 `Check` 使用带 `actions: write` 权限的 job `GITHUB_TOKEN` 发起 `workflow_dispatch`，无需额外 PAT 来触发标签事件或 CI。Agent 执行 job 自身也始终先验证代码。

### 配置并行认证槽位

默认不设置 `CODEX_AUTH_SLOTS`，使用原有 Secret `CODEX_AUTH_JSON`，保持单槽位。调度会保留其余任务的 queued，不同时派发到同一个认证槽位，避免 GitHub concurrency 单 pending 槽覆盖任务。

需要两路并行时：

1. 为每个槽位单独建立并维护 CI 登录，分别保存为仓库 Secrets，例如 `CODEX_AUTH_JSON_A` 和 `CODEX_AUTH_JSON_B`。不能把同一份 auth.json 复制成两份 Secret，也不要在本机同时使用 CI 专用登录。
2. 设置仓库 Variable `CODEX_AUTH_SLOTS` 为 `["CODEX_AUTH_JSON_A","CODEX_AUTH_JSON_B"]`。支持 1–16 个槽位，名字必须以 CODEX_AUTH_JSON 开头，仅含大写字母、数字及下划线。每个槽位都需要有效且可以独立刷新的认证。
3. 原有 `CODEX_AUTH_STORE_PAT` 继续用于各槽位的 Secret 读写。公钥加密包绑定具体 Secret 和更新版本，不能跨槽位回存。
4. 运行 `Codex Promote Queued`。调度只领取空闲槽位，每个就绪任务分配一个；不同槽位并行，同槽位从恢复到回存始终串行。执行完成立即唤醒队列，独立失败不改变其他任务依赖。

直接手动执行会按 Issue/PR 编号选择槽位。同一 Issue 的任务由独立并发组保护。批量启动使用 queued，由晋级器分配空闲槽位；不要批量手动启动多个任务竞争同一槽位。发布后的审查沿用当前槽位，并把槽位预留转交给 PR。

排队后若凭据已更新，或运行期间凭据被替换，工作流拒绝恢复或覆盖旧版本；重新触发新的运行，不重跑旧运行。取消发生在入口接收之前时，先确认对应 Actions 运行已结束，再移除该任务的 dispatching 和 auth 槽位标签、重新添加 queued 恢复。配置槽位池前应结束旧单槽任务。

## 失败和限制

查看 Issue / PR 评论的 Actions 链接。处理原因后重新添加对应标签，或手动启动新的运行。认证回存失败、工作流被取消时，可能需要重新登录并更新 `CODEX_AUTH_JSON`。仓库重新公开后工作流拒绝运行。权限检查失败只在 Actions 中报告，不修改任务状态。已获授权且由调度器领取的任务若在入口预检失败，会移除 dispatching 和认证槽位预留并标记 blocked，供人处理。

若出现 `model is not supported when using Codex with a ChatGPT account`，设置仓库 Variable `CODEX_MODEL` 为该订阅可用的模型；错误中的模型名才是排查线索。Codex 的 stdout 错误现在会额外输出，避免仅看到 `Reading prompt from stdin...`。

每次启动 Codex 时日志显示选用的模型，结束时显示该会话最后一次模型调用的输入 token 数及可用时的上下文上限。审查的三个独立会话分别报告；若会话记录没有用量，日志会显示不可用。

Agent 最长运行 45 分钟，连续无输出 5 分钟失败；生成 job 超时 60 分钟。没有自动批准、自动合并。架构审查每个工作日运行一次，会消耗 Actions 时间与 Codex 订阅用量；不需要时可在 Actions 中禁用该 workflow。

云端执行直接使用 `.sandcastle/prompts/` 中固定的项目模板，不读取或下载 skill。模板以 Sandcastle 官方实现/simple-loop 为骨架，按阶段整理本仓库固定的 TDD、诊断、设计、审查和拆票方法。仓库 skills 保留供本地显式工作使用，来源校验仍由 UPSTREAM.json 维护。

具体适配见 [skill-execution.md](skill-execution.md)。结构化结果不合法或 completed 不是 true 时本轮失败，不发布未完成实现。只读架构和拆票按各自 schema 校验。

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
