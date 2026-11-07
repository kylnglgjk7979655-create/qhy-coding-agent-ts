# GitHub Actions 与 Codex 订阅

仓库采用 [Sandcastle 官方 GitHub workflows](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8/.github/workflows)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。官方任务脚本和 prompt 放在 `.sandcastle/agent-workflows/`，以 `codex()` 替换官方 Claude provider，继续使用 ChatGPT 订阅，不需要 OpenAI API Key。

## 首次配置

将迁移后的配置合入默认分支 `main`，标签事件才会使用新 workflow。已有 PR 先更新到包含新脚本的版本，再使用 PR 标签入口。

### 订阅认证

为 CI 单独登录一次，跟随浏览器使用订阅账号：

```bash
CODEX_HOME="$HOME/.codex-qhy-ci" pnpm exec codex -c 'cli_auth_credentials_store="file"' login
gh secret set CODEX_AUTH_JSON --repo kylnglgjk7979655-create/qhy-coding-agent-ts < "$HOME/.codex-qhy-ci/auth.json"
```

也可以在仓库 Settings → Secrets and variables → Actions 保存完整 `auth.json`。CI 使用这份专用登录后，不再用该目录并行运行本机 Codex；平时的登录目录保持独立。不要把认证文件提交到 git、Issue 或聊天。

创建只限本仓库的 fine-grained PAT，授予 **Secrets → Read and write**，保存为 `CODEX_AUTH_STORE_PAT`。它用于读取 Secret 版本与加密公钥、回存刷新后的 `CODEX_AUTH_JSON`，不会作为 Agent 的环境变量。

### 发布和自动接续

Settings → Actions → General 中启用 **Allow GitHub Actions to create and approve pull requests**。实际审查发布 COMMENT，PR 仍由人决定合并。

父需求共享 PR 的子任务之间使用 `AGENT_PAT` 重新给父 Issue 添加 `agent:implement` 接续；未配置 PAT 时实现后显式调度分支的 `Check` 和同仓库 PR 的 `Agent Review`，审查产生新提交时再对新版本调度 `Check`，避免机器人推送或贴标签不触发下一条 workflow。GitHub 官方将 dispatch 列为该限制的例外，来源见[调查记录](../notes/course-video-manager-ticket-workflows.md#无-agent_pat-时的内部接续)。

配置 `AGENT_PAT`：权限至少为本仓库 **Contents、Issues、Pull requests → Read and write**，推送 workflow 修改时另需 **Workflows → Read and write**。配置后使用该 Token 推送和贴接续标签，不再为同一次转交重复 dispatch。没有 PAT 时，父需求的直接接续会失败并保留队列；Explore 转交的实现标签仍可由定时队列扫描拾取。

| Secret / Variable | 用途 |
| --- | --- |
| Secret `CODEX_AUTH_JSON` | 必需，CI 专用订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 必需，认证版本检查和刷新后回存 |
| Secret `AGENT_PAT` | 父需求子任务直接接续必需；使用 PAT 推送和贴标签接续；其他队列入口可在未配置时使用内置 Token dispatch |
| Variable `CODEX_MODEL` | 可选；优先使用该值，未配置时从 `codex debug models` 选择首个可用模型，探测失败回退 `gpt-6-luna` |

## 日常入口

| workflow | 触发 | 行为 |
| --- | --- | --- |
| Agent Explore | Issue 添加 `agent:explore`；或 Actions 手动运行 | 一次调查所有开放的 explore Issue，识别重复、给出结论，独立 apply job 校验后发布 |
| Agent To Issues | 父 Issue 添加 `agent:to-issues` | 从 GitHub 读取 spec 和评论，结合代码生成待审批计划评论 |
| Agent Publish Tickets | 父 Issue 添加 `agent:publish-tickets` | 批准计划并创建原生子任务和依赖，不启动实现 |
| Agent Implement | Issue／父 Issue 添加 `agent:implement` | 校验依赖；父需求选择就绪子票；父需求复用共享分支和草稿 PR，全部子票完成后请求整体审查；独立 Issue 单独创建 PR |
| Agent Promote Queued | 添加 `agent:queued`；Issue 关闭或重开；同仓库 PR 合并；模型工作流结束；每 5 分钟扫描；Actions 手动运行 | 一次转交一个就绪需求；不运行模型，保留队列以补偿遗漏事件 |
| Agent Review | PR 添加 `agent:review` | 按关联 Issue 和 diff 审查；允许修复并提交，发布评论和回复，标记 Ready |
| Agent Implement PR | PR 留下反馈后添加 `agent:implement` | 修改代码或回复反馈；若既无提交也无评论则失败 |
| Agent Update Branch | 同仓库 PR 添加 `agent:update-branch` | 合并基准分支，发生冲突时才调用 Codex；推送并评论 |

Explore 的手动入口默认 `dry_run=true`，只展示计划；取消勾选才实际发布。添加 `agent:explore` 会直接应用结果：`easy-call` 转 `agent:implement`，`needs-a-human` 转 `ready-for-human`，`blocked` 转 `agent:blocked`；重复 Issue 被评论并关闭。这三个 verdict 是输出字段，不是 GitHub 标签。

`ready-for-agent` 仅表示准备完成，不触发执行。拆票审批与依赖队列是参考 course-video-manager 的项目扩展，详细差异见[调查记录](../notes/course-video-manager-ticket-workflows.md)。定时架构审查仍未启用；历史 Issue 和子 Issue 不自动删除。

## 从 spec 到按依赖实现

1. 将 spec 上传到一个 GitHub 父 Issue 正文，补充要求写在评论。拆票 prompt 直接执行 `gh issue view <编号> --comments`；不依赖本地 spec 副本。
2. 添加 `agent:to-issues`。预检通过后移除 `agent:to-issues` 并添加 `agent:in-progress`，只读 Agent 调查代码并输出 slices；来源快照在 Agent 运行前保存，认证回存成功后，由独立 job 校验并发布完整计划评论。发布或失败后清除 `agent:in-progress`；此时没有子任务，也不执行实现。
3. 在父 Issue 评论中检查每票行为、验收标准和阻塞关系。需要修改时留言，再重新添加 `agent:to-issues`。认可后添加 `agent:publish-tickets`：它批准贴标时已存在的最新有效机器人计划。
4. 发布脚本创建真正的 GitHub 子 Issue，添加 `ready-for-agent`，设置原生父子及 blocked-by 关系，返回带真实票号的评论。发布阶段不调用模型，也不启动实现。
5. 给父 Issue 添加 `agent:implement`。父需求保留 `agent:queued`，每次选择一个依赖已完成的开放子票。第一张子票从 main 创建父需求共享分支和草稿 PR；后续子票在同一分支继续并更新同一个 PR。提交并更新 PR 后关闭该子票为 completed，全部子票完成后对共享 PR 请求整体审查。
6. 子票提交至共享 PR 并关闭后，使用 `AGENT_PAT` 给父 Issue 重新添加 `agent:implement`；下一轮检查依赖后选择就绪票，无需等待 PR 合并；原生依赖而不是标题编号或正文文字决定能否执行。每个父需求最多一个活动子任务。全部子票完成后，移除父需求的排队标签并评论，由维护者验收父需求，脚本不自动关闭它。

独立 Issue 或单个子 Issue 也可以添加 `agent:queued` 预约执行，或直接添加 `agent:implement`；直接执行仍检查本票、父需求的原生依赖和兄弟活动任务。前置票必须以 `completed` 关闭；同父需求的共享 PR 可以保持开放，其他开放实现 PR 仍会阻塞；`not_planned` 不算完成。明确以 completed 关闭人工交付票同样可解锁依赖，仅创建 PR、审查完成或提交代码不会解锁。

### 重新规划、失败与暂停

- 规格正文、标题或人工评论变化会使旧计划失效，必须重新生成再批准。审批后改写的计划也不能发布；人工仿造的计划评论不被接受。只支持一层父子关系，已有其他子任务的父需求不能混入新计划。
- 发布中途失败时，修复原因后重新添加 `agent:publish-tickets`。稳定发布标记能找回已创建但尚未挂接的票，补齐挂接和依赖，避免重复创建。父需求正文不改写、不关闭。
- 实现失败标记当前票 `agent:blocked`，不会自动重试。处理原因后给该票重新添加 `agent:implement`；父需求中其他满足依赖的任务仍可推进。共享 PR 已存在时重试会继续使用原分支和 PR。
- 暂停父需求时添加 `agent:blocked`；暂停独立任务可移除 `agent:queued`。已开始的 Actions 另行取消，恢复时重新添加 `agent:implement`。子票执行后、推送前还会复查票状态和依赖。
- 模型工作流结束后自动唤醒队列，机器人关闭子票也能接续；定时扫描补偿丢失的接续事件以及仍保留执行标签但尚未启动的请求。它发现模型工作流仍在运行或排队时保留队列，空闲后最多发出一个请求。有 PAT 时使用标签事件，没有时贴标签并内部 dispatch；两条路径不会重复启动同一任务。

共享 PR 不会自动合并。

日常仍使用标签。Implement 和 Review 的 `workflow_dispatch` 输入分别为 `issue_number`、`pr_number`，供内部接续；Implement 必须仍携带执行标签，Review 必须为开放、同仓库且仍携带审查标签的 PR，输入编号本身不能绕过授权。队列也提供无参数手动扫描入口。失败后查看 Actions 链接，解决原因，再重新添加对应标签。分支有冲突时先使用 `agent:update-branch`。

## 执行与订阅维护

每条核心流程保留官方独立 job：标签和上下文准备 → 检出与构建 → Agent → 推送、PR、评论。Agent 使用 `noSandbox()` 在临时 Runner 当前分支执行并提交。运行 job 具有官方所声明的 GitHub 权限；仓库维护者需信任任务和所检出的代码。

普通实现使用普通 `run()`，不同时要求 JSON。审查、反馈修改、冲突处理及 Explore 先执行工作，再恢复同一会话提取结构化结果；格式修复按官方次数重试，不重做整个任务。拆票 prompt 与参考仓库对齐，直接输出 slices，由同会话格式修复处理无效输出，来源指纹由包装脚本维护。prompt 要求提交前 typecheck 和相关聚焦测试；`Check` 独立执行 `pnpm check`、`pnpm demo:test`，普通实施脚本本身只检查产生提交。审查不拆成 Standards/Spec 两个固定会话，也不固定加载项目 skills。

[OpenAI 官方 CI/CD 认证说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求让 Codex 正常刷新登录文件、保存更新结果，并避免并行刷新同一份登录。本项目仅为此保留以下适配：

1. workflow 级 `codex-subscription-仓库名` 并发组覆盖认证、运行、回存和发布。
2. `codex-auth-restore` 验证凭据版本、恢复订阅文件并注册日志遮罩；排队后 Secret 已更新的运行拒绝使用旧快照。
3. `codex-auth-save` 在 Agent 返回后（包括失败）加密刷新文件，比较版本并回存 Secret，始终清理临时登录。成功路径必须回存完成，才推送或触发下一轮。

认证 Secret 写入 Token 仅用于恢复和回存步骤；不通过 artifact 传递明文认证。回存与执行在同一 job，不再使用旧的五阶段发布框架。GitHub 并发组只有一个待运行槽，不是 FIFO 队列；不要同时启动多个订阅任务。取消、超时或回存失败后，可能需要重新登录并更新 `CODEX_AUTH_JSON`；不要重跑使用旧凭据的运行。

## 标签准备和本地调试

保留既有五种 triage 标签和执行标签，完整列表见 [triage-labels.md](triage-labels.md)。新仓库需先在 GitHub Labels 创建这些标签；本仓库已有核心标签，扩展标签可用以下命令准备：

```bash
gh label create 'agent:explore' --color 5319E7 --description '批量调查 Issue，识别重复并转交'
gh label create 'agent:to-issues' --color 5319E7 --description '父 Issue：生成待审批的拆票计划' --force
gh label create 'agent:publish-tickets' --color 0E8A16 --description '父 Issue：批准计划，创建子任务和原生依赖' --force
gh label create 'agent:queued' --color FEF2C0 --description 'Issue／父 Issue：等待前置依赖完成后自动启动' --force
gh label create 'agent:in-progress' --color FBCA04 --description 'Agent 当前轮任务执行中' --force
```

本地调试使用官方各阶段所需的环境变量，例如在独立 Git 副本、已创建工作分支且 `gh` 可读该仓库时：

```bash
ISSUE_NUMBER=42 ISSUE_TITLE='修复空输入' BRANCH='agent/issue-42-fix' GH_REPO='owner/repo' pnpm agent:implement
```

本地命令会修改代码并提交，推送和 PR 操作由 GitHub workflow 负责。旧的 `ISSUE_CONTEXT_PATH`、`agent:task` 和 prompt dry-run 入口已移除。来源及全部适配项见 [.sandcastle/README.md](../../.sandcastle/README.md)。
