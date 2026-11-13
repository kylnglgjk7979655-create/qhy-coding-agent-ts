---
name: qa
description: QA 修复循环。按 spec 生成 QA plan 并验收，失败后批量修复再复验，全绿后做一次 code-review；需要"验收到通过"时使用。只读验收、不改代码时用 qa-only。
---

把只读验收接到修复上，直到通过或撞到上限。主代理只做调度和状态，验收判定始终来自独立跑完的 `qa-only`。

## 1. 开始

固定本轮状态：fixed point（调用方指定，未指定时默认 `main`）、spec 来源、被测 `HEAD`；创建 `.scratch/qa/<run-id>/qa-loop.json`，`run-id` 取 `YYYYMMDD-HHmmss-<起始 HEAD 前 7 位>`，整轮循环复用同一个 run 目录。这个目录作为产物目录传给每个 `qa-only` 子代理。

只记录来源指针（issue 号、文件路径、链接）。spec 原文、完整 diff、截图和日志不进主代理。

## 2. 循环

1. 派 `qa-only` 子代理：给 spec 来源、fixed point、run 目录。它产出 `qa-plan.md`、`report.json` 和证据，返回总结果与失败项 ID。
2. `pass` → 第 6 步；`fail` → 下一步；`blocked` 先判断能否自行补齐环境，补齐后重跑该项，无法补齐则停止并报告——blocked 是终态，不进入修复循环。
3. 派 `implement` 子代理：一次修完本轮全部已复现缺陷。缺陷 ID 取自 `report.md` 的缺陷章节（`D1`、`D2`…），与失败项的检查 ID 对应。能落成原生测试的缺陷先写复现测试再修；视觉或设备缺陷不新增 Midscene 测试文件，修完由 `qa-only` 复验。返回 commit SHA。
4. 派 `qa-only` 子代理复验：只跑失败项与相邻回归项。只有代码、相关输入和环境都未变化时才沿用原证据；修复触碰的共享代码必须重跑，返回新总结果。
5. 仍有失败 → 回第 3 步。一轮指一次修复及其复验。同一缺陷最多 3 轮修复，CR 转来的缺陷也计入它自己的 3 轮预算。到上限时停止，在报告写明未通过项、尝试次数和剩余问题，交人工判断。
6. 全绿后派 `code-review` 子代理，审整轮 diff，分别看规范与需求。fixed point：本轮修过代码时取**首次修复前**的 HEAD；首轮即 pass 时取本轮 fixed point。
7. 有效 findings 转成新缺陷（新 ID，同样受 3 轮上限）回第 3 步；没有有效 findings 结束。`code-review` 最多 2 次；第 2 次仍发现新问题就停止并报告。

## 3. 子代理契约

每次派发都必须给：产物目录、fixed point、被测 HEAD、只与它相关的 `qa-plan.md` 条目或 spec 来源、期望返回的结构。子代理自己读取 spec 全文、diff、截图和日志，并读取 `AGENTS.md`、`CODING_STANDARDS.md` 与 `docs/agents/skill-execution.md`。

主代理只接收：总结果、失败项 ID、commit SHA、证据路径、审查 findings 摘要。不转述截图内容，不复制 diff。

## 4. 风险项

`qa` 不代批准。`qa-only` 报告风险项（需要合入共享分支才能验证、push / PR / 标签 / 发布、改共享环境或密钥、不可回滚操作、接管用户桌面）时，立即停止循环，向用户说明风险操作、为什么必须、影响范围和替代方案，等明确批准再继续。

批准只覆盖列明的操作与目标，目标或环境变化后失效。未获批准就把该项记 blocked 并结束，不自行找绕路。修复阶段若发现必须做风险操作（例如只有合入 `main` 才能验证），同样先停下请求批准。

## 5. 委派判据

上下文重（spec、diff、截图、日志）、可独立完成、不影响主代理判断，三条同时成立才交给子代理。缺一条就在主代理内处理，不为委派而拆票。

## 6. 状态文件

`qa-loop.json` 最小字段：`runId`、`fixedPoint`、`crFixedPoint`、`spec`、`head`、`round`、`crRounds`、`verdict`、`defects[{id, checkId, status, attempts, evidence}]`、`rounds[{round, head, verdict, failedChecks, commits}]`、`risks[{id, action, status}]`。每完成一次修复及其复验，追加一条 `rounds` 并把 `round` 加一；`defects.attempts` 记该缺陷已修轮次，`status` 取 `open`、`fixed`、`wontfix`；`risks.status` 取 `pending`、`approved`、`rejected`。`crFixedPoint` 在第一次 CR 前写入，之后不变。

## 7. 结束与边界

结束时返回 `report.md` 路径、总结果、已提交 commit、未解决项和待批准的风险项。允许 commit，不 push、不建 PR；需要推送或合入共享分支才能验证时按 §4 停下等批准。

`blocked` 保留现场与证据，交调用方准备后重跑。确认不修或超出本轮范围的缺陷记 `wontfix`，在报告中单列，不进入后续修复轮次；若它使必验检查失败，该项仍如实记 fail。改动范围不含 `.sandcastle/`、workflow 与 CI；云端 QA 仍由 `agent:qa` 阶段 prompt 调度。复验与修复都不改 `qa-plan.md` 的检查 ID。