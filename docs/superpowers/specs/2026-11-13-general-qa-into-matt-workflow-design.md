# 通用 QA 接入 Matt 工作流 — 设计

日期：2026-11-13
状态：已实现

## 意图

把现有的 Midscene 视觉 QA 接进 Matt 的技能体系，形成"计划 → 验收 → 修复循环 → 审查"的完整 QA 流程。不绑定单一 surface：CLI、Web、桌面、移动设备都由同一份 QA plan 驱动，执行交给 Midscene 对应技能。

## 目标

- 有独立的 **QA plan 阶段**：输入 spec / issues / docs / diff，探测项目入口，产出可审查、可复跑的 `qa-plan.md`。
- **surface 无关**：每条检查标注 surface，按标注分派到 Midscene 技能（web / android / ios / harmony / desktop）；Midscene 支持什么，QA 就能验什么。
- **只读验收与修复分离**：`qa-only` 永不改产品代码；修复由 `qa` 调用 implement 完成。
- **上下文交给子代理**：主循环只持有状态，截图、日志、diff 由子代理消化，返回结构化摘要。

## 非目标

- 不接入 GitHub Actions（至少本轮不做；现有 Sandcastle QA 编排不动）。
- 不生成可重放的 vitest-midscene 测试文件。
- 不重做 Matt 上游 skill，只做项目适配。

## 约束

- 本仓库是 CLI 项目：端到端入口是 `dist/cli.js`，交互面是 TTY。视觉证据走 desktop surface（终端窗口截图）。
- 本地运行：允许 commit，不 push，不建 PR。
- CI 仍由 Codex 执行；本设计的技能放仓库 `.agents/skills/`，Claude 与 Codex 都能读到。

## 方案比较

- **A. 每个缺陷走 implement → CR → 复验三个子代理**：沿用现有 Sandcastle 编排。判定独立、痕迹完整，但冷启动次数随缺陷数线性增长，本地单人对小缺陷过重。**不采用**。
- **B. 单 agent 内联修完再自评**：最省上下文，但修复者给自己判 pass，QA 结论不可信。**不采用**。
- **C. 薄主循环 + 子代理批量作业**（采用）：`qa` 只做调度和状态；`qa-only` 出计划、执行、报告；失败后一次 implement 批量修全部缺陷，再让 `qa-only` 只复验失败项与相邻项；全绿后 code-review 一次。判定始终来自独立的 `qa-only`。

## 设计

### 技能

| 技能 | 状态 | 职责 |
| --- | --- | --- |
| `.agents/skills/qa-only/` | 改造 | 阶段 1 探测并写 `qa-plan.md`；阶段 2 按 surface 分派执行；阶段 3 报告与证据。只读。 |
| `.agents/skills/qa/SKILL.md` | 新增 | 调度 `qa-only`、`implement`、`code-review` 子代理，维护循环状态。 |
| `.agents/skills/qa-only/surfaces.md` | 新增 | surface → Midscene 技能、调用参数、证据约定。 |
| `implement` / `code-review` / `tdd` | 复用 | 修复与审查，不新增变体。 |
| 5 个 Midscene 技能 | 复用 | browser / android / ios / harmonyos / computer 自动化。 |

### 循环

```
qa（持有：run-id、open defects、轮次、HEAD）
  1. qa-only 子代理 → qa-plan.md
  2. qa-only 子代理 → 执行，report + 证据落盘，返回 verdict 与失败项
  3. fail → implement 子代理批量修本轮全部已复现缺陷 → 返回 commits → 回 2
            复验仅跑失败项 + 相邻项；同一问题最多 3 轮（含 CR 后修复）
  4. 全绿 → code-review 子代理，fixed point = 修复前 HEAD，审整轮修复 diff
  5. 有效 findings → 转为新缺陷，回 3
```

### 委派判据

凡是上下文重、可独立完成、且不影响主任务判断的工作，交给子代理：计划执行、Midscene 步骤、截图分析、缺陷修复、diff 审查。主 agent 只接收 verdict、失败项清单、commit SHA、证据路径。

### 上下文分配

| 内容 | 放在哪 |
| --- | --- |
| spec 原文、issues、评论、diff | 只注入 `qa-only` 子代理；主 agent 只记录来源（issue 号 / 路径 / 链接） |
| `qa-plan.md` | 落盘；后续子代理只读自己相关的条目与摘录 |
| 截图、日志、完整 diff | 只进执行 / 修复 / 审查子代理；主 agent 只拿路径与结论 |
| run 状态（open defects、轮次、HEAD） | 主 agent |

`qa-plan.md` 的 `spec 引用` 列承担压缩与可追溯：复验、修复、审查都不重新读取完整 spec。

### surface 分派

| surface | 执行方式 |
| --- | --- |
| web | `browser-automation`（connect / act / assert / take_screenshot） |
| android | `android-device-automation` |
| ios | `ios-device-automation` |
| harmony | `harmonyos-device-automation` |
| desktop | `computer-automation`（终端窗口等同桌面应用处理） |
| 确定性检查 | CLI 走 PTY 原生执行，取 exit code / stdout / stderr / 文件副作用 |

同一检查可同时有 `native` 与 `desktop` 两类证据：前者给判定，后者给渲染证据。

### QA plan 结构

沿用现有五列表，增加四列：

| ID | spec 引用 | surface / 入口 | 前置数据 | 步骤 | 预期 | 证据形式 |
| --- | --- | --- | --- | --- | --- | --- |

写 plan 前先跑一次真实入口做探索（`--help`、启动命令、需要的账号/初态），探索截图作为附件；不单独派 planner 子代理。

### 判定规则

- `pass` / `fail` 必须有非空证据文件；`blocked` 记明缺少的环境或条件。
- 视觉断言只用于可复述、稳定的条件；明确为假 → fail，模型说不清或环境问题 → blocked，主观项只记录。
- 总结果：存在必验 fail → fail；必验项全部 pass → pass；其余 → blocked。

### 产物

`.scratch/qa/<run-id>/`：`qa-plan.md`、`report.json`、`report.md`、`evidence/`、`qa-loop.json`（循环状态）。

## 实现范围

1. 改造 `qa-only/SKILL.md`：计划阶段落盘、surface 分派、与 Midscene 的调用约定。
2. 新增 `qa-only/surfaces.md`。
3. 新增 `qa/SKILL.md`：循环、委派判据、3 轮上限、CR 后置。
4. 更新 `.agents/skills/README.md` 与 `UPSTREAM.json` 的 `projectSkills`（qa、qa-only 为项目自定义）。
5. 不改 Sandcastle prompt、workflow、CI。

## 留给实现者

- `qa-plan.md` 与 `report.json` 的具体字段校验是否复用 `qa-only/report.ts`。
- 探索阶段的截图是否由 desktop surface 统一产出。
- `qa-loop.json` 的最小字段集。