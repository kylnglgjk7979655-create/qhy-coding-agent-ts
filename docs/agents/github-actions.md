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

父需求共享 PR 的子任务之间优先使用 `AGENT_PAT` 重新给父 Issue 添加 `agent:implement` 接续；未配置 PAT 时，完成脚本直接把父票接续写入持久队列。内置 Token 推送后仍显式调度分支的 `Check` 和同仓库 PR 的 `Agent Review`，审查产生新提交时再对新版本调度 `Check`。GitHub 官方将 dispatch 列为 GITHUB_TOKEN 不触发后续 workflow 的例外，来源见[调查记录](../notes/course-video-manager-ticket-workflows.md#无-agent_pat-时的内部接续)。

配置 `AGENT_PAT`：权限至少为本仓库 **Contents、Issues、Pull requests → Read and write**，推送 workflow 修改时另需 **Workflows → Read and write**。配置后使用该 Token 推送和贴接续标签，由 ingress 记录队列请求。没有 PAT 时，内置 Token 通过持久队列完成内部接续；对不会触发后续 workflow 的推送，脚本会显式 dispatch 检查流程。

| Secret / Variable | 用途 |
| --- | --- |
| Secret `CODEX_AUTH_JSON` | 必需，CI 专用订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 必需，认证版本检查和刷新后回存 |
| Secret `AGENT_PAT` | 可选，用于推送和贴接续标签；未配置时，内部任务通过持久队列和内置 Token dispatch |
| Variable `CODEX_MODEL` | 可选；优先使用该值，未配置时从 `codex debug models` 选择首个可用模型，探测失败回退 `gpt-6-luna` |

## 日常入口

| workflow | 触发 | 行为 |
| --- | --- | --- |
| Agent Explore | Issue 添加 `agent:explore`；或 Actions 手动运行 | 先进入持久队列，再一次调查所有开放的 explore Issue，识别重复、给出结论，独立 apply job 校验后发布 |
| Agent To Issues | 父 Issue 添加 `agent:to-issues` | 从 GitHub 读取 spec 和评论，结合代码生成待审批计划评论 |
| Agent Publish Tickets | 父 Issue 添加 `agent:publish-tickets` | 批准计划并创建原生子任务和依赖，不启动实现 |
| Agent Implement | Issue／父 Issue 添加 `agent:implement` | 校验依赖；父需求选择就绪子票；父需求复用共享分支和草稿 PR，全部子票完成后请求整体审查；独立 Issue 单独创建 PR |
| Agent Implement Spec | 父 Issue 添加 `agent:implement-spec` | 使用已有原生子 Issue 和依赖，在单次 Codex 会话内以子代理并行实现、整体审查并交付 PR；不拆票 |
| Agent Promote Queued | Issue 以 completed 关闭 | 检查直接依赖该 Issue 的排队任务并转交就绪任务，不运行模型 |
| Agent Review | PR 添加 `agent:review` | 按关联 Issue 和 diff 审查；允许修复并提交，发布评论和回复，标记 Ready |
| Agent Implement PR | PR 留下反馈后添加 `agent:implement` | 修改代码或回复反馈；若既无提交也无评论则失败 |
| Agent Update Branch | 同仓库 PR 添加 `agent:update-branch` | 合并基准分支，发生冲突时才调用 Codex；推送并评论 |

标签入口统一由 `Agent Queue Ingress` 保存请求，再由 `Agent Queue` 按入队时间串行分发；模型任务运行期间，队列协调器持有仓库级订阅锁。Explore 的手动入口默认 `dry_run=true`，请求同样先进入队列，只展示计划；取消勾选才实际发布。添加 `agent:explore` 会直接应用结果：`easy-call` 转 `agent:implement`，`needs-a-human` 转 `ready-for-human`，`blocked` 转 `agent:blocked`；重复 Issue 被评论并关闭。这三个 verdict 是输出字段，不是 GitHub 标签。没有 `AGENT_PAT` 时，Explore 转交的实现任务也会写入持久队列。

`ready-for-agent` 仅表示准备完成，不触发执行。拆票审批与依赖队列是参考 course-video-manager 的项目扩展，详细差异见[调查记录](../notes/course-video-manager-ticket-workflows.md)。定时架构审查仍未启用；历史 Issue 和子 Issue 不自动删除。

## 从 spec 到按依赖实现

1. 将 spec 上传到一个 GitHub 父 Issue 正文，补充要求写在评论。拆票 prompt 直接执行 `gh issue view <编号> --comments`；不依赖本地 spec 副本。
2. 添加 `agent:to-issues`。预检通过后移除 `agent:to-issues` 并添加 `agent:in-progress`，只读 Agent 调查代码并输出 slices；来源快照在 Agent 运行前保存，认证回存成功后，由独立 job 校验并发布完整计划评论。发布或失败后清除 `agent:in-progress`；此时没有子任务，也不执行实现。
3. 在父 Issue 评论中检查每票行为、验收标准和阻塞关系。需要修改时留言，再重新添加 `agent:to-issues`。认可后添加 `agent:publish-tickets`：它批准贴标时已存在的最新有效机器人计划。
4. 发布脚本创建真正的 GitHub 子 Issue，添加 `ready-for-agent`，设置原生父子及 blocked-by 关系，返回带真实票号的评论。发布阶段不调用模型，也不启动实现。
5. 给父 Issue 添加 `agent:implement`。父需求保留 `agent:queued`，每次选择一个依赖已完成的开放子票。第一张子票从 main 创建父需求共享分支和草稿 PR；后续子票在同一分支继续并更新同一个 PR。提交并更新 PR 后关闭该子票为 completed，全部子票完成后对共享 PR 请求整体审查。
6. 子票提交至共享 PR 并关闭后，使用 `AGENT_PAT` 给父 Issue 重新添加 `agent:implement`；下一轮检查依赖后选择就绪票，无需等待 PR 合并；原生依赖而不是标题编号或正文文字决定能否执行。每个父需求最多一个活动子任务。全部子票完成后，移除父需求的排队标签并评论，由维护者验收父需求，脚本不自动关闭它。

独立 Issue 或单个子 Issue 也可以在前置完成前添加 `agent:queued` 预约执行，或直接添加 `agent:implement`；直接执行仍检查本票、父需求的原生依赖和兄弟活动任务。前置票必须以 `completed` 关闭；同父需求的共享 PR 可以保持开放，其他开放实现 PR 仍会阻塞；`not_planned` 不算完成。明确以 completed 关闭人工交付票同样可解锁依赖，仅创建 PR、审查完成或提交代码不会解锁。

### 重新规划、失败与暂停

- 规格正文、标题或人工评论变化会使旧计划失效，必须重新生成再批准。审批后改写的计划也不能发布；人工仿造的计划评论不被接受。只支持一层父子关系，已有其他子任务的父需求不能混入新计划。
- 发布中途失败时，修复原因后重新添加 `agent:publish-tickets`。稳定发布标记能找回已创建但尚未挂接的票，补齐挂接和依赖，避免重复创建。父需求正文不改写、不关闭。
- 实现失败标记当前票 `agent:blocked`，不会自动重试。处理原因后给该票重新添加 `agent:implement`；父需求中其他满足依赖的任务仍可推进。共享 PR 已存在时重试会继续使用原分支和 PR。
- 暂停父需求时添加 `agent:blocked`；暂停独立任务可移除 `agent:queued`。已开始的 Actions 另行取消，恢复时重新添加 `agent:implement`。子票执行后、推送前还会复查票状态和依赖。
- 持久队列请求保存在来源 Issue/PR 的状态评论中，记录请求类型、等待/执行/终态和关联 Actions 运行，不包含认证信息。重复投递按请求 ID 合并；队列每五分钟扫描一次，也会在新请求到达时立即启动，用于恢复调度中断。
- 队列分发前再次核验来源开放状态、授权标签和 PR 分支 SHA；具体任务仍执行原有 Issue 依赖与发布前检查。撤销标签、关闭来源或更新 PR 分支会取消旧请求，修正后重新添加标签即可生成新请求。
- 普通任务失败后队列继续处理其他请求。订阅恢复或回存步骤失败时队列暂停；更新 `CODEX_AUTH_JSON` 或 `CODEX_AUTH_STORE_PAT` 后，调度器检测到 Secret 指纹变化并恢复等待请求。调度中断若无法确认子 workflow 状态，不会自动重放；请求会标记失败并说明查看 Actions 与重新授权的方式。
- 已排队依赖任务仍只在直接前置 Issue 以 completed 关闭时变为就绪；若此前置的实现 PR 尚未合并，或排队发生在关闭之后，需要在条件满足后人工重新添加 `agent:implement`。

共享 PR 不会自动合并。

### 使用 implement-spec

父 Issue 正文和评论提供 spec，先准备真实的子 Issue 和原生阻塞关系，再添加 `agent:implement-spec`。执行时不能同时给父票或子票添加 `agent:implement`、`agent:queued`、`agent:in-progress` 或 `agent:blocked`。父票和子票的外部前置必须已以 completed 关闭；子任务须全部开放，依赖不得成环。

该标签授权单次 Codex 会话按仓库内 `implement-spec` 启动并行子代理和独立 worktree，合并到 `agent/spec-父票编号` 集成分支。首项合并后创建草稿 PR，完成整体审查及检查后标记 Ready。PR 包含父票和子票的关闭引用，在合并时由 GitHub 关闭。运行中会推送集成分支和创建草稿 PR；认证回存及最终检查完成后才标记 Ready。

如果运行失败或取消，请查看运行日志和已有分支、PR，手工核查进度。为避免重放已有工作，存在同名远程分支时本流程拒绝重新启动；该流程目前不自动恢复部分完成的运行。移除标签可以撤销等待中的任务；运行中的任务须在 Actions 中取消。

日常仍使用标签。各任务 workflow 的 `workflow_dispatch` 是队列 worker 的内部执行入口，需要有效的 `queue_request_id`；用户从标签入口提交任务。失败后查看队列请求评论中的 Actions 链接，解决原因，再重新添加对应标签。分支有冲突时先使用 `agent:update-branch`。

## 执行与订阅维护

每条核心流程保留官方独立 job：标签和上下文准备 → 检出与构建 → Agent → 推送、PR、评论。Agent 使用 `noSandbox()` 在临时 Runner 当前分支执行并提交。运行 job 具有官方所声明的 GitHub 权限；仓库维护者需信任任务和所检出的代码。

普通实现使用普通 `run()`，不同时要求 JSON。审查、反馈修改、冲突处理及 Explore 先执行工作，再恢复同一会话提取结构化结果；格式修复按官方次数重试，不重做整个任务。拆票 prompt 与参考仓库对齐，直接输出 slices，由同会话格式修复处理无效输出，来源指纹由包装脚本维护。prompt 要求提交前 typecheck 和相关聚焦测试；`Check` 独立执行 `pnpm check`、`pnpm demo:test`，普通实施脚本本身只检查产生提交。审查不拆成 Standards/Spec 两个固定会话，也不固定加载项目 skills。

[OpenAI 官方 CI/CD 认证说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求让 Codex 正常刷新登录文件、保存更新结果，并避免并行刷新同一份登录。本项目仅为此保留以下适配：

1. workflow 级 `codex-subscription-仓库名` 并发组覆盖认证、运行、回存和发布。
2. `codex-auth-restore` 验证凭据版本、恢复订阅文件并注册日志遮罩；排队后 Secret 已更新的运行拒绝使用旧快照。
3. `codex-auth-save` 在 Agent 返回后（包括失败）加密刷新文件，比较版本；仅在登录文件内容变化时回存 Secret，始终清理临时登录。内容未变化时不重写 Secret，避免仅因 `updated_at` 改变就让排队任务被误判为旧快照。成功路径必须完成此检查及必要的回存，才推送或触发下一轮。

队列在上一项完成并回存后才 dispatch 下一项，因此新任务在执行时读取最新 `CODEX_AUTH_JSON`。认证恢复仍会比较 workflow 创建时间与 Secret 版本；若 Secret 在任务 run 创建后、恢复前被外部改写，任务会在调用 Codex 前失败，核对回存日志并重新添加授权标签即可安全重试。

认证 Secret 写入 Token 仅用于恢复和回存步骤；不通过队列评论或 artifact 传递明文认证。队列协调器串行等待每个子 workflow 完成，锁覆盖认证恢复、模型运行、认证回存及发布。取消或超时后，定时调度会先查询关联运行；无法确认的请求进入失败状态供人工核查，不会盲目重放模型或发布动作。回存失败会暂停队列；确认并修复认证后重新添加对应授权标签继续。

## 标签准备和本地调试

保留既有五种 triage 标签和执行标签，完整列表见 [triage-labels.md](triage-labels.md)。新仓库需先在 GitHub Labels 创建这些标签；本仓库已有核心标签，扩展标签可用以下命令准备：

```bash
gh label create 'agent:explore' --color 5319E7 --description '批量调查 Issue，识别重复并转交'
gh label create 'agent:to-issues' --color 5319E7 --description '父 Issue：生成待审批的拆票计划' --force
gh label create 'agent:publish-tickets' --color 0E8A16 --description '父 Issue：批准计划，创建子任务和原生依赖' --force
gh label create 'agent:queued' --color FEF2C0 --description 'Issue／父 Issue：等待前置依赖完成后自动启动' --force
gh label create 'agent:implement-spec' --color 5319E7 --description '父 Issue：并行实现已有子任务' --force
gh label create 'agent:in-progress' --color FBCA04 --description 'Agent 当前轮任务执行中' --force
```

本地调试使用官方各阶段所需的环境变量，例如在独立 Git 副本、已创建工作分支且 `gh` 可读该仓库时：

```bash
ISSUE_NUMBER=42 ISSUE_TITLE='修复空输入' BRANCH='agent/issue-42-fix' GH_REPO='owner/repo' pnpm agent:implement
```

本地命令会修改代码并提交，推送和 PR 操作由 GitHub workflow 负责。旧的 `ISSUE_CONTEXT_PATH`、`agent:task` 和 prompt dry-run 入口已移除。来源及全部适配项见 [.sandcastle/README.md](../../.sandcastle/README.md)。
