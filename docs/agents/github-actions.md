# GitHub Actions 与 Agent 认证

仓库采用 [Sandcastle 官方 GitHub workflows](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8/.github/workflows)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。官方任务脚本和 prompt 放在 `.sandcastle/agent-workflows/`，模型适配替换为官方 `sandcastle.claudeCode()`，通过 Anthropic 兼容端点调用 Claude Code。

## 首次配置

标签触发的 workflow **只读取默认分支（main）上的文件**。改动 `.github/workflows/` 后，必须先合入 main，标签事件才会使用新版本。

### 模型认证

CI 使用百度千帆 Token Plan 的 Anthropic 兼容端点，不使用订阅登录，也不回存登录态：

- `ANTHROPIC_BASE_URL`：`https://qianfan.baidubce.com/anthropic/tokenplan/personal`（已作为默认值写在 `shared/common.ts`，可在仓库 Variable 中覆盖）；
- `ANTHROPIC_AUTH_TOKEN`：仓库 Secret，存放 CI 专用 API Key；
- Variable `AGENT_MODEL`：可选，默认 `deepseek-v4.1-flash`；未配置时使用默认值。

```bash
gh secret set ANTHROPIC_AUTH_TOKEN --repo <owner>/<repo>
```

workflow 会在运行 Agent 前全局安装 `@anthropic-ai/claude-code`，并写入 `~/.claude.json` 的 `hasCompletedOnboarding`，避免非交互运行停在引导页。

### 必需的 PAT

GITHUB_TOKEN 贴出的标签不会触发下游 workflow，因此 `AGENT_PAT` 是必需配置，用于：

- 父需求子票完成后的 `agent:implement` 接续；
- implement 完成后给 PR 贴 `agent:review`；
- 依赖 Issue 关闭后的 `agent:queued` → `agent:implement` 推进；
- 推送分支，使 push 事件正常触发 `Check`。

创建一个只限本仓库的 fine-grained PAT，授予 **Contents、Issues、Pull requests → Read and write**；如果 Agent 需要推送 `.github/workflows/**`，再加 **Workflows → Read and write**。

### 发布和自动接续

Settings → Actions → General 中启用 **Allow GitHub Actions to create and approve pull requests**。实际审查发布 COMMENT，PR 仍由人决定合并。

| Secret / Variable | 用途 |
| --- | --- |
| Secret `ANTHROPIC_AUTH_TOKEN` | 必需，CI 专用千帆 API Key |
| Secret `AGENT_PAT` | 必需，用于推送和标签接续；未配置时接续步骤会失败 |
| Variable `AGENT_MODEL` | 可选；默认 `deepseek-v4.1-flash` |
| Variable `ANTHROPIC_BASE_URL` | 可选；覆盖代码中的千帆端点默认值 |

## 日常入口

标签直接触发对应 workflow，没有持久队列。每个 workflow 使用 `concurrency` group、`cancel-in-progress: false`：

| 入口 | 并发组 | 行为 |
| --- | --- | --- |
| 父 Issue：`agent:to-issues` | per Issue | 调用 `/to-tickets`，校验需求后自动创建子 Issue 和原生依赖 |
| Issue／父 Issue：`agent:implement` | per Issue | 调用 `/implement`；完成后同会话调用 `/pr`，workflow 推送并创建／更新 Draft PR |
| PR：`agent:review` | per PR | 调用 `/code-review`，读取完整 spec 并发布 COMMENT；完成后标记 Ready |
| PR 评论后加 `agent:implement` | per PR | 处理反馈，需要改代码时调用 `/implement` |
| PR：`agent:update-branch` | per PR | 合并最新基准；有冲突时调用 Agent |
| Issue 以 completed 关闭 | per Issue | Promote Queued 检查直接依赖它的排队任务，不运行模型 |

`agent:review`、`agent:implement`（PR）、`agent:update-branch` 共用同一个 per-PR 并发组，保证不会同时改写同一分支；不同 Issue、不同 PR 属于不同组，可以并行。

`ready-for-agent` 只表示准备完成。QA 暂不接入 workflow：`agent:qa` / `agent:qa-only` 入口已移除。`agent:explore` 与 `agent:implement-spec` 入口同样已移除，本地仍可用对应 skill。

## 从 Spec 到交付

1. 将 Spec 放在 GitHub 父 Issue 正文，补充要求写在评论。
2. 添加 `agent:to-issues`。预检后移除触发标签，父 Issue 标记 in-progress；只读 Agent 输出 slices，由独立发布 job 校验来源快照，自动创建真实子 Issue、ready-for-agent 标签和原生父子／阻塞关系。完成后清除 in-progress。没有人工拆票审批。
3. 检查子票后，给父 Issue 添加 `agent:implement` 开始实现；拆票本身不会写代码。父需求保留 agent:queued，每次选择一个依赖已完成的开放子票，共用 `agent/parent-父编号` 分支和一个 Draft PR。同一父需求的子票串行。
4. Agent 使用 `/implement` 写代码、运行 `pnpm check` 并提交；同一会话调用 `/pr` 编写 Summary、Evidence、Merge Danger。文案必须区分已交付与待实现内容；只报告真实验证证据。
5. workflow 验证 PR 元数据、复查依赖后推送，创建或更新 PR。共享 PR 的正文包含 `Closes #父编号`；独立 Issue 的 PR 关闭自身。
6. 子票提交到共享 PR 后以 completed 关闭，然后用 `AGENT_PAT` 重新给父 Issue 贴 `agent:implement` 接续下一票。
7. 全部子票 completed 后移除父需求 queued，给 PR 贴 `agent:review`。审查上下文通过原生父子关系显式读取父 PRD、全部子票及评论。
8. Review 发布 COMMENT 并标记 Ready；Check 独立执行 `pnpm check` 和 `pnpm demo:test`。维护者决定合并，合入 main 后 GitHub 自动关闭父 Issue。共享 PR 不自动合并。

## 失败、暂停与恢复

- 旧 `agent:publish-tickets` 标签和独立工作流已停用。尚未创建子票的旧计划，重新添加 `agent:to-issues`。
- 拆票时需求正文、标题或人工评论变化，来源校验会拒绝创建。需要基于新需求重新拆票。
- 创建子票中途失败时，重新运行失败的发布 job：它复用该运行的来源和计划 artifact，补齐子任务和依赖而不重复创建。失败时标记父票 blocked；成功恢复后清除。
- 实现失败不会自动重试。处理原因后重新给当前票加 `agent:implement`，继续原分支和共享 PR。
- 暂停父需求可加 `agent:blocked`；已运行的 Actions 需另外取消，恢复时重新添加 `agent:implement`。推送前会重新检查票状态及依赖。
- 依赖以前置 Issue 以 completed 关闭为准；not_planned 不算完成。
- 删除触发标签、关闭来源或更新 PR 分支会取消尚未开始的运行；需要继续时重新加标签。
- 没有持久队列状态评论；运行状态以 Actions 日志、`agent:in-progress` / `agent:blocked` 标签和 PR 评论为准。

## 标签与本地调试

标签含义见 [triage-labels.md](triage-labels.md)。本地调试时准备独立 checkout、工作分支及可读仓库的 gh 环境，例如：

```bash
ANTHROPIC_AUTH_TOKEN=<key> ISSUE_NUMBER=42 ISSUE_TITLE='修复空输入' BRANCH='agent/issue-42' GH_REPO='owner/repo' pnpm agent:implement
```

该命令会提交代码，并要求 Agent 使用 `/pr` 写出 PR 文案；推送及 GitHub 发布由工作流负责。本地运行需要全局安装 `@anthropic-ai/claude-code`（`npm install -g @anthropic-ai/claude-code`）。

项目规范的唯一入口是根目录 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)，AGENTS.md、CLAUDE.md 和阶段 prompt 均引用它。skill 调用与交付边界见 [skill-execution.md](skill-execution.md)。