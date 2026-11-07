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

沿用官方的 `AGENT_PAT` 标签接续方式。为实现后自动启动审查、Explore 后自动启动实现配置此 Secret，权限至少为本仓库 **Contents、Issues、Pull requests → Read and write**。允许推送 workflow 修改时另需 **Workflows → Read and write**。没有 PAT 时回退 `GITHUB_TOKEN` 能完成部分写入，但它添加的标签不会启动下一条 workflow；需由维护者重新添加对应标签。代码推送是否触发 `Check` 同样受 GitHub Token 事件限制，本项目不再使用自定义 dispatch 接续。

| Secret / Variable | 用途 |
| --- | --- |
| Secret `CODEX_AUTH_JSON` | 必需，CI 专用订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 必需，认证版本检查和刷新后回存 |
| Secret `AGENT_PAT` | 自动接续需要；代码推送、PR 创建、标签转交按官方流程使用 |
| Variable `CODEX_MODEL` | 可选；优先使用该值，未配置时从 `codex debug models` 选择首个可用模型，探测失败回退 `gpt-6-luna` |

## 日常入口

| workflow | 触发 | 行为 |
| --- | --- | --- |
| Agent Explore | Issue 添加 `agent:explore`；或 Actions 手动运行 | 一次调查所有开放的 explore Issue，识别重复、给出结论，独立 apply job 校验后发布 |
| Agent Implement | 独立 Issue 添加 `agent:implement` | 从 main 创建 `agent/issue-*` 分支，Agent 提交，workflow 推送并创建草稿 PR，再请求审查 |
| Agent Review | PR 添加 `agent:review` | 按关联 Issue 和 diff 审查；允许修复并提交，发布评论和回复，标记 Ready |
| Agent Implement PR | PR 留下反馈后添加 `agent:implement` | 修改代码或回复反馈；若既无提交也无评论则失败 |
| Agent Update Branch | 同仓库 PR 添加 `agent:update-branch` | 合并基准分支，发生冲突时才调用 Codex；推送并评论 |

Explore 的手动入口默认 `dry_run=true`，只展示计划；取消勾选才实际发布。添加 `agent:explore` 会直接应用结果：`easy-call` 转 `agent:implement`，`needs-a-human` 转 `ready-for-human`，`blocked` 转 `agent:blocked`；重复 Issue 被评论并关闭。这三个 verdict 是输出字段，不是 GitHub 标签。

`ready-for-agent` 仅表示准备完成，不触发执行。普通实现按官方 MVP 拒绝有父 Issue 或子 Issue 的需求。原有 `agent:to-issues`、`agent:publish-tickets`、`agent:queued` 和定时架构审查已退出执行链路；历史 Issue、子 Issue 和旧标签不自动删除。

除 Explore 外，官方入口没有手动 `issue_number` / `pr_number` 参数。失败后查看 Actions 链接，解决原因，再重新添加对应标签。Review 和 Implement PR 使用 `pull_request` 事件；分支有冲突时先使用 `agent:update-branch`。

## 执行与订阅维护

每条核心流程保留官方独立 job：标签和上下文准备 → 检出与构建 → Agent → 推送、PR、评论。Agent 使用 `noSandbox()` 在临时 Runner 当前分支执行并提交。运行 job 具有官方所声明的 GitHub 权限；仓库维护者需信任任务和所检出的代码。

普通实现使用普通 `run()`，不同时要求 JSON。审查、反馈修改、冲突处理及 Explore 先执行工作，再恢复同一会话提取结构化结果；格式修复按官方次数重试，不重做整个任务。prompt 要求提交前 typecheck 和相关聚焦测试；`Check` 独立执行 `pnpm check`、`pnpm demo:test`，普通实施脚本本身只检查产生提交。审查不再拆成 Standards/Spec 两个固定会话，也不固定加载项目 skills。

[OpenAI 官方 CI/CD 认证说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求让 Codex 正常刷新登录文件、保存更新结果，并避免并行刷新同一份登录。本项目仅为此保留以下适配：

1. workflow 级 `codex-subscription-仓库名` 并发组覆盖认证、运行、回存和发布。
2. `codex-auth-restore` 验证凭据版本、恢复订阅文件并注册日志遮罩；排队后 Secret 已更新的运行拒绝使用旧快照。
3. `codex-auth-save` 在 Agent 返回后（包括失败）加密刷新文件，比较版本并回存 Secret，始终清理临时登录。成功路径必须回存完成，才推送或触发下一轮。

认证 Secret 写入 Token 仅用于恢复和回存步骤；不通过 artifact 传递明文认证。回存与执行在同一 job，不再使用旧的五阶段发布框架。GitHub 并发组只有一个待运行槽，不是 FIFO 队列；不要同时启动多个订阅任务。取消、超时或回存失败后，可能需要重新登录并更新 `CODEX_AUTH_JSON`；不要重跑使用旧凭据的运行。

## 标签准备和本地调试

保留既有五种 triage 标签和官方执行标签，完整列表见 [triage-labels.md](triage-labels.md)。新仓库需先在 GitHub Labels 创建这些标签；本仓库已有核心标签，可补充：

```bash
gh label create 'agent:explore' --color 5319E7 --description '批量调查 Issue，识别重复并转交'
```

本地调试使用官方各阶段所需的环境变量，例如在独立 Git 副本、已创建工作分支且 `gh` 可读该仓库时：

```bash
ISSUE_NUMBER=42 ISSUE_TITLE='修复空输入' BRANCH='agent/issue-42-fix' GH_REPO='owner/repo' pnpm agent:implement
```

本地命令会修改代码并提交，推送和 PR 操作由 GitHub workflow 负责。旧的 `ISSUE_CONTEXT_PATH`、`agent:task` 和 prompt dry-run 入口已移除。来源及全部适配项见 [.sandcastle/README.md](../../.sandcastle/README.md)。
