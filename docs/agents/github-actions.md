# GitHub Actions 与 Codex

此配置使用 [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle) 发布的 `@ai-hero/sandcastle@0.14.0` 和固定版本的 `@openai/codex`。安装版本以 `package.json` 与 `pnpm-lock.yaml` 为准。

## 使用 Codex 订阅

本地 `pnpm agent:implement` 默认使用 `CODEX_AUTH_MODE=chatgpt`：先确认当前机器的 `codex login status` 显示 `Logged in using ChatGPT`，未登录时执行 `codex login`。不需要 `OPENAI_API_KEY`。脚本会清空传给 Codex 的 API Key 环境变量，防止意外切换为 API 计费；CLI 自行读取和刷新已有登录状态。

本仓库目前公开，现有 GitHub 临时 Runner 模板仍为显式 API 模式。订阅登录不会随源码或当前电脑的登录状态自动进入云端 Runner；切换到订阅云端运行还需要选择受信任的私有运行环境及登录态保存方式，不能只删除 API Key 就完成迁移。

[OpenAI 官方订阅 CI 指南](https://learn.chatgpt.com/docs/auth/ci-cd-auth) 说明：此流程用于受信任的私有自动化，不用于公开或开源仓库。运行中刷新后的 `auth.json` 必须持久化，并限制同一份认证只由单台机器或串行任务使用。GitHub 临时 Runner 每轮销毁，仅保存原始登录文件而不回存刷新结果不能作为持久方案；固定 Runner 可在磁盘保留刷新后的认证。凭据不进入仓库、日志或 Actions artifacts。

私有仓库也有 GitHub Free 的计算额度；仓库可见性与 Codex 订阅额度分别管理。CI 检查可以继续使用现有 workflow。

## GitHub 临时 Runner 的 API 配置

1. 把本次配置提交并推送到 GitHub 默认分支。Issue 标签事件使用默认分支上的 workflow；仅有本地文件不会启动云端任务。
2. 在仓库 **Settings → Secrets and variables → Actions → Secrets** 添加 `OPENAI_API_KEY`。它应是有可用余额且能访问所选模型的 OpenAI Platform API Key。只在 GitHub 的 Secret 输入框录入，密钥不进入仓库文件、Issue 或日志。
3. 在 **Settings → Actions → General → Workflow permissions** 开启 **Allow GitHub Actions to create and approve pull requests**。组织策略可能需要管理员开启。各 job 的读写权限已在 YAML 中单独声明。
4. 在 **Actions → Setup Agent Labels → Run workflow** 运行一次，创建缺少的分诊和执行标签。
5. 创建一个需求明确的 GitHub Issue，写明复现步骤、期望行为和验收条件，添加 `ready-for-agent` 或 `agent:implement`。触发者需有仓库写权限。也可从 **Actions → Codex Implement Issue → Run workflow** 填 Issue 编号手动启动。
6. 查看 Actions 日志，等待 Issue 中出现草稿 PR 链接。审查修改、检查结果后人工合并；PR 的 `Closes #编号` 会在合并时关闭 Issue。

当前入口接受普通 GitHub Issue，并按完整 Issue 实现；没有接入 PR 评论修复、PRD 子任务逐轮编排、自动架构审查或自动合并。

## 认证与模型

| 配置位置 | 名称 | 是否必需 | 用途 |
| --- | --- | --- | --- |
| Actions secret | `OPENAI_API_KEY` | 现有云端 API 模板需要 | 仅在 Sandcastle 调用步骤映射为 Codex 的 `CODEX_API_KEY` |
| Actions secret | `AGENT_PAT` | 可选 | 发布分支和 PR，使后续 `Check` 可由机器人创建的 PR 自动触发 |
| Actions variable | `CODEX_MODEL` | 可选 | 覆盖默认模型 `gpt-5.4`；填写当前认证可访问的 Codex 模型 ID |

`OPENAI_API_KEY` 使用 OpenAI API 的计费与配额；不会自动继承当前电脑上 Codex 的 ChatGPT 登录状态。演示 CLI 中的 `agent.config.json`、第三方 `baseURL` 和 `.env` 与云端 Codex 认证分开。

有 `AGENT_PAT` 时，发布 job 使用 PAT 推送并创建 PR。PAT 限制到本仓库，授予 Contents、Issues、Pull requests 读写权限；如果要修改 `.github/workflows/`，还需 Workflows 写权限。Classic PAT 对应 `repo`，修改 workflow 另需 `workflow`。不要把 PAT 放入 Issue 或代码。

未设置 PAT 时，发布 job 使用自动提供的 `GITHUB_TOKEN`。生成阶段仍会验证修改并创建草稿 PR，但这类 Token 产生的推送和 PR 事件不会触发新的 `Check`。需要独立的 PR 状态检查时，配置 PAT，或在 PR 分支手动运行 `Check`；如果推送包含 workflow 文件修改，默认 Token 可能拒绝。

## 执行过程

`prepare → generate → publish → finish` 分为四个 job。

- `prepare` 验证触发者权限、开放状态和现有 PR，读取 Issue 与全部评论，固定默认分支的 SHA，移除触发及阻塞标签，添加 `agent:in-progress`。
- `generate` 在该 SHA 的独立分支安装依赖，通过 `.sandcastle/implement.ts` 调用 `run({ agent: codex(...), sandbox: noSandbox() })`。随后重新安装锁定依赖，执行 `pnpm check`、`pnpm demo:test`，将修改导出为补丁。没有修改或检查失败时停止。
- `publish` 在新 Runner 中从同一 SHA 检出，应用补丁、提交并普通推送到本轮唯一分支，创建草稿 PR。它不会运行补丁中的代码，也不接收模型密钥。提交信息为 `fix: implement issue #编号`，PR 说明包含 Agent 摘要和检查命令。
- `finish` 发布结果或失败说明，并移除 `agent:in-progress`；失败时添加 `agent:blocked`。

同一 Issue 使用并发组串行运行。已有开放关联 PR 时拒绝重复实现。运行期间 Issue 被关闭或出现关联 PR 时停止发布。每轮分支包含 Issue 编号、运行 ID 与重试次数，使用普通 push，不覆盖旧分支。

本配置中的 `noSandbox()` 表示 Agent 直接操作临时 Runner，Sandcastle 的 Codex provider 使用无人值守权限参数；GitHub 临时 Runner 是其运行边界。生成 job 只有仓库读权限、checkout 不保留 GitHub 凭据；模型密钥只配置在调用步骤。依赖安装及验证步骤不配置模型密钥。Issue 和评论被作为 JSON 需求数据传给 Agent，不拼接进 shell 命令。

## 检查与时间限制

`Check` 在 PR、推送到 `main` 或手动触发时执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm demo:test
```

Node 与 pnpm 跟随仓库版本配置。`pnpm check` 会检查 `.sandcastle/` TypeScript、构建项目并执行测试。`demo:bug` 是故意保留的失败演示，`smoke` 会调用真实模型，均未加入 CI。

Codex 单轮最多运行 45 分钟，无输出 5 分钟失败；生成 job 总超时 60 分钟。它只执行一轮完整任务，不会无上限重试模型调用。

## 失败后重试

查看 Issue 评论中的 Actions 链接。常见原因包括缺少模型密钥、模型不可访问、API 配额不足、依赖或测试失败、PR 创建权限未启用。

处理原因后重新添加任一触发标签即可重试；workflow 会清除旧的 `agent:blocked`。若已有开放 PR，需要先处理该 PR；关闭后才会重新实现。取消整个 workflow 可能中断清理，可手动移除遗留的 `agent:in-progress`。失败前已经推送的分支会保留供排查。

## 本地检查提示词

只预览提示词无需密钥，也不会调用模型：

```bash
ISSUE_CONTEXT_PATH=/tmp/issue.json pnpm agent:implement --dry-run
```

JSON 格式：

```json
{
  "number": 42,
  "title": "修复空输入时的错误",
  "body": "复现步骤、期望行为和验收条件……",
  "url": "https://github.com/owner/repo/issues/42",
  "comments": [{ "author": "maintainer", "body": "补充说明" }]
}
```

订阅用户实际运行时，先在机器上执行 `codex login`，并用 `codex login status` 确认是 ChatGPT 登录。在独立克隆中执行：

```bash
ALLOW_HOST_EXECUTION=1 ISSUE_CONTEXT_PATH=/tmp/issue.json pnpm agent:implement
```

只有明确使用 API 时才设置 `CODEX_AUTH_MODE=api-key` 和 `CODEX_API_KEY`。本地运行只产生工作目录修改及 `.sandcastle/output/summary.md`，不会推送或创建 PR；读取现有仓库凭据的能力取决于本地环境。生成文件及 Sandcastle 日志已加入 `.gitignore`。

## 参考

- [Sandcastle Agent providers](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/agent-providers.md)
- [Sandcastle Sandbox providers](https://github.com/mattpocock/sandcastle/blob/main/docs/guide/sandbox-providers.md)
- [OpenAI 官方非交互运行文档](https://developers.openai.com/codex/noninteractive/)
- [OpenAI 官方认证文档](https://developers.openai.com/codex/auth/)
