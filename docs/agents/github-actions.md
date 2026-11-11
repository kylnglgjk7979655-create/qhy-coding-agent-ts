# GitHub Actions 与 Codex 订阅

仓库采用 [Sandcastle 官方 GitHub workflows](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8/.github/workflows)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。官方任务脚本和 prompt 放在 `.sandcastle/agent-workflows/`，以 `codex()` 替换官方 Claude provider，继续使用 ChatGPT 订阅，不需要 OpenAI API Key。

## 首次配置

将迁移后的配置合入默认分支 `main`，标签事件才会使用新 workflow。CR、QA、QA Only 和分支更新保留 workflow 对应提交的 runner 与依赖，被测 PR 按授权 SHA 检出到独立的 `worktree/`；在该目录运行产品检查和修复，从保留的版本读取 skill。旧 PR 无需先合并 QA 命令或 skill 即可进入验收。普通实现仍使用任务分支中的脚本；已有父需求共享分支继续实现前，先用 `agent:update-branch` 同步 main。

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

配置 `AGENT_PAT`：权限至少为本仓库 **Contents、Issues、Pull requests → Read and write**，推送 workflow 修改时另需 **Workflows → Read and write**。配置后使用该 Token 推送和贴父任务接续标签，由 ingress 记录队列请求。普通 implement → CR → QA 的接续统一使用内置 Token 写持久队列，以保留来源并避免 PAT 标签事件重复入队。没有 PAT 时，内置 Token 通过持久队列完成内部接续；对不会触发后续 workflow 的推送，脚本会显式 dispatch 检查流程。

| Secret / Variable | 用途 |
| --- | --- |
| Secret `CODEX_AUTH_JSON` | 必需，CI 专用订阅登录文件 |
| Secret `CODEX_AUTH_STORE_PAT` | 必需，认证版本检查和刷新后回存 |
| Secret `AGENT_PAT` | 可选，用于推送和贴接续标签；未配置时，内部任务通过持久队列和内置 Token dispatch |
| Variable `CODEX_MODEL` | 可选；优先使用该值，未配置时从 `codex debug models` 选择首个可用模型，探测失败回退 `gpt-6-luna` |

## 日常入口

所有标签由 `Agent Queue Ingress` 写入持久队列，`Agent Queue` 按入队时间分发；用户使用标签，任务 workflow 的 dispatch 是带 queue_request_id 的内部入口。

| 入口 | 行为 |
| --- | --- |
| 父 Issue：`agent:to-issues` | 调用 `$to-tickets`，校验需求后自动创建子 Issue 和原生依赖 |
| Issue／父 Issue：`agent:implement` | 调用 `$implement`；完成后同会话调用 `$pr`，workflow 推送并创建／更新 Draft PR |
| 父 Issue：`agent:implement-spec` | 使用已有原生子 Issue 和依赖，在单次 Codex 会话内并行委派实现、整体审查并交付 PR；不拆票 |
| PR：`agent:review` | 调用 `$code-review`，读取完整 spec 并发布 COMMENT；手动 CR 完成后标记 Ready，implement 发起的 CR 完成后接 QA |
| PR：`agent:qa` | 验收、委派 implement 修复、CR 和复验，发布报告及证据；通过后标记 Ready |
| PR：`agent:qa-only` | 显式调用 `$qa-only`，读取完整 spec，实际运行验收并发布报告和证据；保持代码与 Ready 状态不变 |
| PR：评论后加 `agent:implement` | 处理反馈，需要改代码时调用 `$implement` |
| PR：`agent:update-branch` | 合并最新基准；有冲突时调用 Agent |
| Issue：`agent:explore` | 批量调查全部开放的 explore Issue，识别重复、发布结论和转交 |
| Issue 以 completed 关闭 | Promote Queued 检查直接依赖它的排队任务，不运行模型 |

`ready-for-agent` 只表示准备完成。Explore 的手动入口默认 dry-run；标签入口会实际应用结果。定时架构审查未启用。

## 从 Spec 到交付

1. 将 Spec 放在 GitHub 父 Issue 正文，补充要求写在评论。
2. 添加 `agent:to-issues`。预检后移除触发标签，父 Issue 标记 in-progress；只读 Agent 输出 slices，认证回存成功后，由独立发布 job 校验来源快照，自动创建真实子 Issue、ready-for-agent 标签和原生父子／阻塞关系。完成后清除 in-progress。没有人工拆票审批。
3. 检查子票后，给父 Issue 添加 `agent:implement` 开始实现；拆票本身不会写代码。父需求保留 agent:queued，每次选择一个依赖已完成的开放子票，共用 `agent/parent-父编号` 分支和一个 Draft PR。父内、父间均由订阅队列串行调度。
4. Agent 使用 `$implement` 写代码、运行 `pnpm check` 并提交；同一会话调用 `$pr` 编写 Summary、Evidence、Merge Danger。文案必须区分已交付与待实现内容；只报告真实验证证据，人工 QA 不冒充通过。
5. workflow 验证 PR 元数据、保存刷新登录态、复查依赖后推送，创建或更新 PR。共享 PR 的正文包含 `Closes #父编号`；独立 Issue 的 PR 关闭自身。旧共享分支先更新到包含新脚本的 main，下一轮实现才会更新正文。若旧 PR 已完成所有实现，合并前需确认正文已含父票关闭指令。
6. 子票提交到共享 PR 后以 completed 关闭，然后自动接续下一票。有 PAT 时重新贴父票 implement；未配置时直接记录持久队列请求。同父共享 PR 不阻塞后续票，其他开放实现 PR 仍可能阻塞依赖。
7. 全部子票 completed 后移除父需求 queued，请求整体 CR。审查上下文通过原生父子关系显式读取父 PRD、全部子票及评论；旧 PR 首条 Closes 指向子票时同样会定位父需求。
8. Review 发布 COMMENT，自动接续 QA；QA 验收并在需要时委派修复、CR、复验，通过后标记 PR Ready。手动添加 `agent:review` 不自动接续 QA。Check 独立执行 `pnpm check` 和 `pnpm demo:test`。维护者决定合并，合入 main 后 GitHub 自动关闭父 Issue，无需再单独验收关闭父票。共享 PR 不自动合并。

## QA 与 QA Only

配置合入 `main` 后，为同仓库的开放 PR 添加 `agent:qa-only`。runner、prompt 和 skill 使用 workflow 对应的固定版本，产品代码与依赖使用授权的 PR 快照。标签入口沿用订阅持久队列，绑定入队时的 PR HEAD；不直接运行真实模型 smoke，也不自动修复问题。

```bash
gh label create agent:qa-only --color 5319E7 --description '只读功能验收：生成 QA plan、运行产品并报告证据' --force
gh pr edit <PR编号> --add-label agent:qa-only
```

阶段 prompt 显式传入 Spec、fixed point、被测 HEAD 和仓库外的 artifact 目录。先保存 `qa-plan.md`，然后运行已有的 CLI/API/浏览器入口。每项 pass/fail 都必须有实际证据文件；缺少环境或预期时如实记录 blocked，尚未执行项保留 not-run。所有必验项通过才为 pass，存在失败为 fail，其余未完成为 blocked。已确认且未解决的修复仍为 fail；尚未完成验收的说明文本不会单独将 blocked 升级为已确认失败。

认证回存成功、PR HEAD 未变后，workflow 将中文报告发布为 PR 评论。Actions 中的 `qa-only-PR编号-run编号` artifact 保存 `spec.md` 来源快照、计划、`report.md`、`result.json` 和脱敏证据，保留 14 天。运行期间改动产品文件或提交、引用不存在的证据时，runner 拒绝发布有效验收结论。输出目录必须是新的，重跑不会覆盖旧报告。

验收门禁在 Actions 日志和 Job Summary 中展示完整报告；fail / blocked 都会阻止放行，所以该次 workflow 仍为红色。fail / blocked 会使该次 workflow 失败并标记 `agent:blocked`，但不改变 PR 的 Draft/Ready 状态。处理原因后重新添加 `agent:qa-only`；失败不会自动重试。运行失败时仍尝试保存已生成的证据。人工 QA 的已执行、待执行状态独立保留。

`agent:qa` 是验收与修复入口，`agent:qa-only` 保留为只读报告入口，两者均使用只读的 `$qa-only` skill。普通 implement 完成后自动请求整体 CR，并在持久队列记录 `qa_after_review=true`；该 CR 成功后排队 QA。手动添加 `agent:review` 不记录接续标志，不自动运行 QA。`implement-spec` 暂不接入。

```bash
gh label create agent:qa --color 5319E7 --description '功能验收、修复、CR 和复验' --force
gh pr edit <PR编号> --add-label agent:qa
```

QA 主 Agent 只调度，在独立上下文中分别启动 QA、implement 和 CR subagent，显式调用 `$qa-only`、`$implement` 和 `$code-review`。发现范围内缺陷后由 implement 修复并提交，CR 只返回 findings；新增修改重新经过 CR 和 QA。范围外旧问题仅记录。同一问题最多三次修复，CR 后修复也计入；达到上限时报告 fail、累计次数及剩余问题，不因更换 subagent 重置。

workflow 保存刷新登录态、确认远程 PR 仍为入队版本后推送修复，并发布最终版本的报告。`qa-PR编号-run编号` artifact 保存 spec、各轮计划、证据和结果，保留 14 天。通过结果必须绑定实际复验的最终 HEAD，有修复时还必须绑定最后一次通过 CR 的 HEAD。fail / blocked 也发布报告，然后标记 `agent:blocked`；失败不会自动重试。只有 QA 通过才将普通自动链路的 Draft PR 标记 Ready。

本地验收并修复时，在待验收分支设置 `PR_NUMBER`、`BRANCH` 和可读仓库的 `GH_REPO`，运行 `pnpm agent:qa`。该命令会提交修复，不推送或发布 GitHub 结果；`OUTPUT_DIR` 必须位于仓库外，每次使用新的输出目录。产品文件变化检测不提供操作系统沙箱；测试副作用应限定到隔离 fixture。

## 使用 implement-spec

父 Issue 正文和评论提供 spec；先准备真实的子 Issue 和原生阻塞关系，再添加 `agent:implement-spec`。父票和子票不能同时带有 `agent:implement`、`agent:queued`、`agent:in-progress` 或 `agent:blocked`。父票及子票的外部前置必须以 completed 关闭，子任务须全部开放，依赖不得成环。

该标签授权单次 Codex 会话按仓库内 `implement-spec` 启动并行子代理和独立 worktree，合并到 `agent/spec-父票编号` 集成分支。首项合并后创建 Draft PR；整体审查和检查完成后标记 Ready。PR 包含父票和子票的关闭引用，合并时由 GitHub 关闭。它作为一个队列任务运行；队列仍串行持有仓库级订阅锁。

运行失败或取消后，查看运行日志和已有分支、PR并手工核查进度。为避免重放已有工作，存在同名远程分支时流程拒绝重新启动；目前不自动恢复部分完成的运行。移除标签可撤销等待中的任务；运行中的任务须在 Actions 中取消。

## 失败、暂停与恢复

- 旧 `agent:publish-tickets` 标签和独立工作流已停用。尚未创建子票的旧计划，重新添加 agent:to-issues；已有子票时先核对并清理旧关系，避免重复拆分。
- 拆票时需求正文、标题或人工评论变化，来源校验会拒绝创建。需要基于新需求重新拆票。
- 创建子票中途失败时，查看失败运行并重新运行失败的发布 job：它复用该运行的来源和计划 artifact，稳定标记能找回已创建但未挂接的票，补齐依赖而不重复创建。若需换一份计划，先处理已有子票。失败时标记父票 blocked；成功恢复后清除。
- 实现失败不会自动重试。处理原因后重新给当前票加 agent:implement，继续原分支和共享 PR。队列继续处理其他普通请求；CI 测试失败也不会自动唤醒修复 Agent，需在 PR 评论说明问题并重新加 agent:implement。
- 暂停父需求可加 agent:blocked；已运行的 Actions 需另外取消，恢复时重新添加 agent:implement。推送前会重新检查票状态及依赖。
- 依赖以前置 Issue 以 completed 关闭为准；not_planned 不算完成。依赖推进仅检查关闭票的直接排队依赖；若排队晚于关闭、或外部前置 PR 当时仍开放，条件满足后需重新添加 implement。
- 持久队列请求在来源 Issue/PR 的机器人评论中记录 waiting、running、completed、failed、cancelled、paused 及关联运行；不含认证信息。请求到达即调度，每五分钟扫描等待请求。定时扫描不是失败自动重试，也不是重新扫描所有依赖标签。
- 分发前重新核验来源开放状态、执行标签和 PR SHA。撤销标签、关闭来源或更新 PR 分支会取消旧请求；需要继续时重新加标签。
- 调度中断后先查询关联运行；无法确认时标记失败供人工核查，不盲目重放。认证恢复或回存失败会暂停队列，修复认证 Secret 后根据指纹变化恢复等待请求。

## 订阅与检查职责

队列协调器持有 `codex-subscription-仓库名` 的 workflow 级锁，等待子工作流完成后才分发下一项。锁覆盖认证恢复、模型运行、刷新回存和发布。

`codex-auth-restore` 恢复专用登录、核验 Secret 版本并注册日志遮罩；`codex-auth-save` 在 Agent 返回后（包括失败）检查登录文件，只有内容变化时才加密回存 Secret，随后清理临时登录。回存成功后才发布，不经 artifact 或队列评论传递明文认证。队列新任务在运行时读取最新 Secret。

项目规范的唯一入口是根目录 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)，AGENTS.md 和阶段 prompt 均引用它。skill 调用与交付边界见 [skill-execution.md](skill-execution.md)。普通实现不要求最终回复为 JSON；PR 文案通过仓库外的元数据文件交付。审查、反馈修改、冲突处理、Explore 沿用工作后同会话提取，格式失败只修复输出。

## 标签与本地调试

标签含义见 [triage-labels.md](triage-labels.md)。本地调试时准备独立 checkout、工作分支及可读仓库的 gh 环境，例如：

```bash
ISSUE_NUMBER=42 ISSUE_TITLE='修复空输入' BRANCH='agent/issue-42' GH_REPO='owner/repo' pnpm agent:implement
```

该命令会提交代码，并要求 Agent 使用 `$pr` 写出 PR 文案；推送及 GitHub 发布由工作流负责。来源与适配见 [.sandcastle/README.md](../../.sandcastle/README.md)。
