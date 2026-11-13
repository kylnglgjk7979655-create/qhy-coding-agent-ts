# 通用 QA 接入 Matt 工作流 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `qa-only` 具备独立 QA plan 阶段与 surface 分派，并新增 `qa` 技能串起"验收 → 批量修复 → 复验 → CR"的本地循环。

**Architecture:** 全部是仓库内 skill 文档与清单改动，无运行时代码。`qa-only` 负责只读验收并把计划、报告、证据落盘；`qa` 是薄调度层，只持有 run 状态，把 spec、diff、截图、修复交给子代理。`tests/skills.test.ts` 的 SHA256 清单是每步的验证门禁。

**Tech Stack:** Markdown skill 文件、`UPSTREAM.json` 清单、vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-13-general-qa-into-matt-workflow-design.md`

## Global Constraints

- 文档与新增内容默认中文；引用上游原文时保留原语言。
- 只改 `.agents/skills/**`、`.gitignore`、本设计文档的状态行。`.sandcastle/**`、`src/**`、`tests/**` 一行不动。
- 每改一个 `.agents/skills/` 下的文件，都要同步 `UPSTREAM.json` 的 `sha256`；`pnpm vitest run tests/skills.test.ts` 必须通过。
- `qa-only` 永久只读：不得修改产品代码、产品测试、依赖和配置；修复只由 `qa` 的 implement 子代理执行。
- 本地运行：允许 commit，不 push、不建 PR。
- 产物目录 `.scratch/qa/<run-id>/`，整个 `.scratch/qa/` 加入 `.gitignore`；run-id 格式 `YYYYMMDD-HHmmss-<7 位 HEAD>`。
- 全量 `pnpm check` 在本 worktree 有 4 项已知的环境性失败（`/var` 与 `/private/var` 路径差异、PTY 超时），不作为本计划的回归门禁；本计划的门禁是 `pnpm typecheck` 与 `tests/skills.test.ts`。

## Review Focus

- 新 `qa` 技能与 Sandcastle 的 `$qa` 命名：`.sandcastle/` 只调用 `$qa-only`，新增目录不得改变现有 prompt 的解析。
- `qa` 与 `qa-only` 触发词重叠：两个 description 必须让调用方能分清"只读验收"与"验收到通过"。
- Midscene 环境缺失（`MIDSCENE_MODEL_API_KEY` / `MODEL_NAME` / `MODEL_BASE_URL` / `MODEL_FAMILY` 未设、设备未连）时应记 blocked，不能记 fail。
- 证据文件为空或路径跳出 run 目录时判定不成立；截图不得提交进仓库。
- 同一缺陷 3 轮上限（含 CR 后修复）必须对 CR 发现的新缺陷同样生效，否则循环可能不收敛。

---

### Task 0: 提交设计基线

**Files:**
- Commit: `CLAUDE.md`（未跟踪）、`docs/superpowers/`（未跟踪）

**Interfaces:**
- Produces: 本计划与设计文档进入版本库，后续任务的 `git diff` 只包含本次实现。

- [ ] **Step 1: 提交**

```bash
git add CLAUDE.md docs/superpowers
git commit -m "docs: add CLAUDE.md import and general QA design"
```

- [ ] **Step 2: 确认工作树干净**

Run: `git status --short`
Expected: 无输出

---

### Task 1: `qa-only` 增加计划落盘与产物目录

**Files:**
- Modify: `.agents/skills/qa-only/SKILL.md`
- Modify: `.gitignore`
- Modify: `.agents/skills/UPSTREAM.json`（`sha256` 中 `qa-only/SKILL.md`）

**Interfaces:**
- Produces: `qa-plan.md` 的 7 列表头 `| ID | Spec 引用 / acceptance criterion | surface / 入口 | 前置数据 | 步骤 | 预期结果 | 证据形式 |`；产物目录与 `run-id` 命名规则；`report.json` 字段形状（Task 3 的 `qa` 直接读取）。

- [ ] **Step 1: 先跑一次清单校验，确认它当前是绿的**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: PASS（1 passed）

- [ ] **Step 2: 改 frontmatter description**

`.agents/skills/qa-only/SKILL.md` 第 3 行改为：

```yaml
description: 功能验收。生成并落盘 QA plan，按 surface 实际运行产品并记录证据；用于 CR 后验收、修复后复验，或只读检查，不修改产品代码和测试。
```

- [ ] **Step 3: 在 §1 末尾加产物目录**

在"记录比较基准、当前 HEAD、未提交产品改动和运行环境"之后追加一段：

```md
创建本轮产物目录 `.scratch/qa/<run-id>/`，`run-id` 取 `YYYYMMDD-HHmmss-<被测 HEAD 前 7 位>`。本轮的计划、报告与证据只写入该目录，不覆盖先前运行。
```

并在 `.gitignore` 末尾追加，保持既有空行分组风格：

```
# 本地 QA 运行产物
.scratch/qa/
```

- [ ] **Step 4: 改写 §3 生成 QA plan**

把现有表格替换为：

```md
| ID | Spec 引用 / acceptance criterion | surface / 入口 | 前置数据 | 步骤 | 预期结果 | 证据形式 |
| --- | --- | --- | --- | --- | --- | --- |
```

并在该节内补三条，顺序为：探索、落盘、完成条件：

- 写计划前先跑一次真实入口（`--help`、启动命令、必需账号与初态），把结果记为探索证据；探索截图只在该计划含视觉项时产出，按其 surface 采集。
- 计划写入 `.scratch/qa/<run-id>/qa-plan.md`，含 spec 来源与版本、探索记录、上表。调用方已提供计划时读入该文件，补齐缺口，保留原 ID。
- 完成条件：每项必验行为都填满 7 列，或写明阻塞原因。`surface` 取 `web` / `android` / `ios` / `harmony` / `desktop` / `native`。

- [ ] **Step 5: §4 增加 surface 分派**

在"不同入口观察不同结果"表格后追加：

```md
按每项计划的 `surface` 选择执行工具，映射、调用入口与证据约定见 [surface 分派](surfaces.md)。确定性检查优先用原生入口（CLI 走真实终端或 PTY，取 exit code、stdout、stderr 与文件副作用）；需要渲染证据时用 desktop surface 追加截图，判定仍以原生观察为准。
```

- [ ] **Step 6: §5 写明产物文件**

把"使用报告模板，写入调用方指定的产物目录"一段改为指定固定文件名：

```md
使用 [报告模板](report-template.md)，写入 `.scratch/qa/<run-id>/` 或调用方指定目录：`report.md`、`report.json`、`evidence/`。`report.json` 采用 `spec`、`summary`、`checks[{id, specReference, steps, expected, actual, status, evidence}]`、`findings`、`humanQa` 字段，另记 `verdict`、`head`、`fixedPoint`。证据路径相对 run 目录且为非空文件。
```

- [ ] **Step 7: 确认校验失败（红）**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: FAIL，报 `qa-only/SKILL.md` 的 sha256 不符

- [ ] **Step 8: 更新校验值**

Run: `shasum -a 256 .agents/skills/qa-only/SKILL.md`
把输出的十六进制值写入 `UPSTREAM.json` 的 `sha256["qa-only/SKILL.md"]`。

- [ ] **Step 9: 确认通过（绿）**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add .agents/skills/qa-only/SKILL.md .agents/skills/UPSTREAM.json .gitignore
git commit -m "docs(qa-only): persist QA plan and artifact layout"
```

---

### Task 2: 新增 `qa-only/surfaces.md`

**Files:**
- Create: `.agents/skills/qa-only/surfaces.md`
- Modify: `.agents/skills/UPSTREAM.json`（新增 `sha256["qa-only/surfaces.md"]`）

**Interfaces:**
- Consumes: Task 1 的 `surface` 取值 `web` / `android` / `ios` / `harmony` / `desktop` / `native`。
- Produces: 每个 surface 的调用入口与证据约定；`qa` 与后续复验都引用这份文件，不再重述命令。

- [ ] **Step 1: 写文件，内容为下列结构与表格**

标题"Surface 分派"。表格列 `surface | 技能 | 调用入口 | 证据`，行：

| surface | 技能 | 调用入口 | 证据 |
| --- | --- | --- | --- |
| web | `browser-automation` | `npx -y @midscene/web@1 connect`，随后 `act` / `assert` / `take` | 页面截图 |
| android | `android-device-automation` | `npx -y @midscene/android@1 ...`，`--device-id` 指定设备 | 设备截图 |
| ios | `ios-device-automation` | `npx -y @midscene/ios@1 ...` | 设备截图 |
| harmony | `harmonyos-device-automation` | `npx -y @midscene/harmony@1 ...` | 设备截图 |
| desktop | `computer-automation` | `npx -y @midscene/computer@1 ...`，`list` 选目标窗口 | 窗口截图 |
| native | 无（直接用产品入口） | `node dist/cli.js ...`；交互式用 PTY (`script -qefc`) | exit code、stdout、stderr、文件副作用 |

- [ ] **Step 2: 写规则**

表格后逐条列出：

- 一个检查只有一个执行 surface；需要渲染证据时用 `desktop` 追加，判定仍以该检查的原生观察为准。
- 视觉断言只写可复述、稳定的条件；"看起来正常"不能作为预期。
- 前置条件缺失（`MIDSCENE_MODEL_API_KEY`、`MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_FAMILY` 任一未设，设备未连接，依赖未安装）→ 该项记 `blocked`，不记 `fail`。
- 本地运行 `computer-automation` 会接管真实鼠标和键盘：先用 `list` 确认目标窗口，执行完 `disconnect`；能读到终端输出完成的检查不要走桌面。
- 证据命名 `evidence/<检查 ID>-<步骤序号>.<png|log|json>`，必须非空；失败项保留操作前后截图。
- 同一 surface 的多步操作复用一次 `connect` 会话，结束时 `disconnect`。

- [ ] **Step 3: 登记校验值**

Run: `shasum -a 256 .agents/skills/qa-only/surfaces.md`
把值写入 `UPSTREAM.json` 的 `sha256["qa-only/surfaces.md"]`（键按字典序放在 `report-template.md` 之后）。

- [ ] **Step 4: 校验**

Run: `pnpm vitest run tests/skills.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add .agents/skills/qa-only/surfaces.md .agents/skills/UPSTREAM.json
git commit -m "docs(qa-only): add surface dispatch reference"
```

---

### Task 3: 新增 `qa` 技能

**Files:**
- Create: `.agents/skills/qa/SKILL.md`
- Create: `.agents/skills/qa/agents/openai.yaml`
- Modify: `.agents/skills/README.md`（表格加一行）
- Modify: `.agents/skills/UPSTREAM.json`（`projectSkills.qa` + 两个 `sha256`）

**Interfaces:**
- Consumes: Task 1 的产物目录、`qa-plan.md` 列定义、`report.json` 字段；Task 2 的 surface 分派。
- Produces: `qa-loop.json` 的最小字段集：`runId`、`fixedPoint`、`spec`、`head`、`round`、`verdict`、`defects[{id, status, evidence}]`、`rounds[{round, head, verdict, failedChecks}]`。

- [ ] **Step 1: 写 `qa/SKILL.md` frontmatter**

```yaml
---
name: qa
description: QA 修复循环。按 spec 生成 QA plan 并验收，失败后批量修复再复验，全绿后做一次 code-review；需要"验收到通过"时使用。只读验收、不改代码时用 qa-only。
---
```

- [ ] **Step 2: 写正文 §1 开始**

固定本轮状态：fixed point（调用方指定，未指定时默认 `main`）、spec 来源、被测 `HEAD`；创建 `.scratch/qa/<run-id>/qa-loop.json`。说明主循环只持有这些状态，不读取 spec 原文、完整 diff、截图与日志。

- [ ] **Step 3: 写 §2 循环**

编号步骤，内容为：

1. 派 `qa-only` 子代理：给定 spec 来源、fixed point、run 目录；返回 `report.json` 与总结果。
2. `pass` → 跳到第 6 步；`fail` / `blocked` → 下一步。
3. 派 `implement` 子代理：一次修本轮全部已复现缺陷，缺陷 ID 与 `report.json` 对齐；返回 commit SHA。
4. 派 `qa-only` 子代理复验：只跑失败项与相邻回归项，沿用未变化项的证据；返回新总结果。
5. 仍有失败回到第 3 步。同一缺陷最多 3 轮修复（含 CR 后修复）；达到上限时停止，在报告写明未通过项、尝试次数与剩余问题。
6. 全绿后派 `code-review` 子代理，fixed point 取本轮**首次修复前**的 HEAD，审整轮修复 diff。
7. 有效 findings 转成新缺陷（新 ID），回到第 3 步；无有效 findings 结束。

- [ ] **Step 4: 写 §3 子代理契约**

两组清单：

- 每次派发必须提供：run 目录、fixed point、被测 HEAD、只与该子代理相关的 `qa-plan.md` 条目或 spec 来源、期望返回的结构。
- 主代理只接收：总结果、失败项 ID、commit SHA、证据路径、审查 findings 摘要。子代理自行读取 spec 全文、diff、截图。

- [ ] **Step 5: 写 §4 委派判据与 §5 状态文件**

委派判据三条：上下文重（spec、diff、截图、日志）、可独立完成、不影响主代理判断。三者同时成立才交给子代理；不满足的在主代理内处理，不拆票。

`qa-loop.json` 字段照 **Interfaces** 给出的集合写，每轮追加 `rounds` 记录。

- [ ] **Step 6: 写 §6 结束与边界**

结束时返回 `report.md` 路径、总结果、已提交 commit、未解决项。允许 commit，不 push、不建 PR。`blocked` 保留现场与证据，交由调用方准备后重跑。改动范围不含 `.sandcastle/`、CI 与 workflow；云端 QA 仍走 `agent:qa`。

- [ ] **Step 7: 写 `qa/agents/openai.yaml`**

```yaml
interface:
  display_name: "QA"
  short_description: "验收并修复到通过：QA plan、批量修复、复验，全绿后审查"
```

- [ ] **Step 8: README 加一行**

在 `.agents/skills/README.md` 表格 `qa-only` 之后插入：

```md
| qa | QA 与修复循环：验收失败后批量修复并复验，全绿后一次 CR | 项目自定义 |
```

并在表格后的说明段落补一句：`qa` 是本地循环入口，云端仍由 `agent:qa` 阶段 prompt 调度；两者都复用 `qa-only` 的只读验收与产物格式。

- [ ] **Step 9: 登记清单**

`UPSTREAM.json` 的 `projectSkills` 增加：

```json
"qa": {
  "description": "项目自定义的本地 QA 与修复循环；复用 qa-only、implement 与 code-review。",
  "references": [
    "https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d",
    "https://github.com/garrytan/gstack/tree/6b327148e37134e2628d2d20cd98f33dcbeef51c"
  ]
}
```

Run: `shasum -a 256 .agents/skills/qa/SKILL.md .agents/skills/qa/agents/openai.yaml`
把两个值写入 `sha256`（排在 `qa-only/*` 之后）。

- [ ] **Step 10: 校验**

Run: `pnpm vitest run tests/skills.test.ts && pnpm typecheck`
Expected: PASS，无类型错误

- [ ] **Step 11: 提交**

```bash
git add .agents/skills/qa .agents/skills/README.md .agents/skills/UPSTREAM.json
git commit -m "docs: add qa fix loop skill"
```

---

### Task 4: 全量验证与设计状态

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-general-qa-into-matt-workflow-design.md`（`状态：待确认` → `状态：已实现`）

**Interfaces:**
- Consumes: Task 1–3 的全部产物。

- [ ] **Step 1: 自查覆盖**

逐条对照设计文档"实现范围"1–5：改造 `qa-only/SKILL.md`、新增 `surfaces.md`、新增 `qa/SKILL.md`、更新 README 与 `projectSkills`、`.sandcastle/` 未改。缺哪条回对应任务补。

Run: `git diff --stat 1c38064..HEAD`
Expected: 只出现 `.agents/skills/**`、`.gitignore`、`CLAUDE.md`、`docs/superpowers/**`

- [ ] **Step 2: 跑门禁**

Run: `pnpm vitest run tests/skills.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: 更新设计状态并提交**

```bash
git add docs/superpowers/specs/2026-11-13-general-qa-into-matt-workflow-design.md
git commit -m "docs: mark general QA design implemented"
```