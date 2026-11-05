# GitHub Actions 与 Codex 订阅

工作流使用私有仓库的 GitHub Ubuntu Runner，通过 Sandcastle 的 `codex()` 运行订阅账号，不需要 OpenAI API Key。

## 首次配置

### 1. 把工作流合入默认分支

提交本地配置并合入 GitHub 的 `main`。Issue 标签事件使用默认分支上的 workflow；只有本地文件不会启动云端任务。标签已创建，首次在其他仓库使用时可手动运行 `Setup Agent Labels`。

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

选择一种方式：

- 使用默认 `GITHUB_TOKEN`：在 Settings → Actions → General → Workflow permissions 勾选 **Allow GitHub Actions to create and approve pull requests**。各 job 已在 YAML 声明需要的权限，默认工作流权限可保持只读。
- 配置可选的 **`AGENT_PAT`**：fine-grained PAT 限制到本仓库，授予 Contents、Pull requests 读写和 Issues 读取权限。它用于推送及创建 PR，还能触发后续 `Check`。修改 workflow 文件时另需 Workflows 写权限。

未配置 `AGENT_PAT` 时，由默认 Token 创建的 PR 不会自动触发新一轮 CI；生成 job 仍会先执行检查。需要独立 PR 检查状态时配置 PAT，或在 PR 分支手动运行 `Check`。

## 日常使用

创建 GitHub Issue，写清复现步骤或需求、期望结果、验收条件。添加 **`agent:implement`** 或 **`ready-for-agent`** 标签。

然后在 Actions → Codex Implement Issue 查看进度。也可在该 workflow 的 Run workflow 中填写 Issue 编号手动启动。成功后 Issue 会出现草稿 PR 链接，由人审查并决定合并；PR 的 `Closes #编号` 在合并时关闭 Issue。

| Secret / Variable | 是否必需 | 用途 |
| --- | --- | --- |
| Secret `CODEX_AUTH_JSON` | 是 | CI 专用的 Codex 订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 是 | 自动回存刷新后的登录态，Secrets 读写权限 |
| Secret `AGENT_PAT` | 可选 | 发布 PR 并触发后续 CI |
| Variable `CODEX_MODEL` | 可选 | 覆盖默认 `gpt-5.4`，需是该订阅可使用的模型 |

云端工作流不读取 `OPENAI_API_KEY`。演示 CLI 的 `agent.config.json`、第三方 baseURL 和 `.env` 与此订阅认证分开。

## 登录态怎样维护

GitHub 临时 Runner 每轮结束都会销毁，因此每轮需要恢复、运行、保存。[OpenAI 官方说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 要求保存 Codex 自己刷新后的登录文件，并串行使用同一份认证。

工作流分为五个 job：

1. `prepare` 只允许私有仓库和有写权限的触发者，拒绝重复 PR，获取 Issue、评论及 Secret 公钥和版本。
2. `generate` 恢复订阅登录，通过 Sandcastle 运行 Codex；用 GitHub 公钥加密最新登录态后，清理临时明文文件，再运行依赖安装、`pnpm check` 与 `pnpm demo:test`，导出代码补丁。
3. `persist-auth` 在独立 Runner 上把加密登录态写回 `CODEX_AUTH_JSON`。它不执行 Agent 生成的代码，也不解密认证包。生成任务失败后，若已有认证包仍会尝试保存刷新结果。
4. `publish` 在代码验证及认证回存成功后，应用补丁、提交、推送唯一分支并创建草稿 PR。
5. `finish` 发布结果，移除 `agent:in-progress`；失败添加 `agent:blocked`。

运行 Codex 的 job 没有仓库写入 Token 或 Secret 写入 Token。跨 job 只传递公钥加密后的认证包，明文 `auth.json` 不进入 artifacts。工作流自带的恢复步骤会注册凭据日志遮罩。

所有实现任务共用一个并发组，避免并发刷新同一登录。GitHub 默认并发组只保留一个待运行任务，因此请在上一轮完成后再启动下一项。排队后凭据发生更新、或运行中被其他操作替换时，工作流拒绝使用或覆盖旧版本；此时重新添加标签创建新的运行，不要重跑旧运行。

## 失败和限制

查看 Issue 评论的 Actions 链接。处理原因后重新添加触发标签即可重试。认证回存失败或工作流被取消时，可能需要重新执行专用登录并更新 `CODEX_AUTH_JSON`。仓库重新转为公开后，订阅工作流会拒绝运行。

Agent 最多运行 45 分钟，连续无输出 5 分钟失败；生成 job 超时 60 分钟。`demo:bug` 是故意失败的演示，`smoke` 调用真实模型，均未纳入 CI。本配置没有自动合并、PR 反馈修改或 PRD 子任务逐轮实现。

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
