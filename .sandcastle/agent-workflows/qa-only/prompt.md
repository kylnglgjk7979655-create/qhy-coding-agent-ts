# TASK

验收 PR #{{PR_NUMBER}}，branch 为 `{{BRANCH}}`。

使用 $qa-only skill 执行本次功能验收。显式提供以下输入：

- **Spec**：下方 SPEC 的完整内容，包括 parent issue、相关 sub-issues 及补充评论。不要用单个 sub-issue 替代完整 spec。
- **Fixed point**：`{{FIXED_POINT}}`。
- **Tested HEAD**：`{{TESTED_HEAD}}`。
- **Artifacts directory**：`{{ARTIFACTS_DIRECTORY}}`，证据路径相对此目录记录。

PR title: {{PR_TITLE}}

# SPEC

{{SPEC}}

# PR BODY

{{PR_BODY}}

# DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# EXECUTION

读取 `AGENTS.md`、`docs/agents/skill-execution.md`、`GLOSSARY.md` 及相关 ADR。遵循仓库固定的 `{{SKILLS_DIRECTORY}}/qa-only/SKILL.md`：先在 Artifacts directory 保存 `qa-plan.md`，再通过原生入口运行产品并保存脱敏证据。

SPEC 已提供时直接使用。若显示没有关联 issue，按 skill 查找 spec；找不到时记录 blocked，不编造预期。每个本轮 acceptance criterion 都应对应检查；未执行项记录 not-run 或 blocked 及原因。

优先使用项目已有的本地夹具和隔离数据，明确替身不能证明的行为。需要真实服务、凭据或交互条件而当前无法取得时，报告 blocked。普通测试通过不能代替功能验收。

所有 QA 报告、证据、fixture 和临时配置写到 Artifacts directory；产品代码、产品测试、项目依赖与项目配置保持不变。记录初态、精确操作、实际输出和最终效果；pass / fail 的检查必须有非空证据文件。

只验收和报告，不调用修复 skill，不修改或提交产品文件。不 push、不操作标签、不创建 GitHub 评论、不改变 PR Ready 状态；发布由 workflow 负责。已有人工 QA 的真实状态单独保留。

完成后输出 `<promise>COMPLETE</promise>`。验收 fail / blocked 也是本次验收的有效结果，不要为得到 pass 而修改产品或省略失败项。
