---
name: qa
description: QA 修复循环。按 spec 生成 QA plan 并验收，失败后批量修复再复验，全绿后做一次 code-review；需要"验收到通过"时使用。只读验收、不改代码时用 qa-only。
---

把只读验收接到修复上，直到通过或撞到上限。主代理只做调度和状态，验收判定始终来自独立跑完的 `qa-only`。

## 1. 开始

固定本轮状态：fixed point（调用方指定，未指定时默认 `main`）、spec 来源、被测 `HEAD`；创建 `.scratch/qa/<run-id>/qa-loop.json`，`run-id` 取 `YYYYMMDD-HHmmss-<HEAD 前 7 位>`。

只记录来源指针（issue 号、文件路径、链接）。spec 原文、完整 diff、截图和日志不进主代理。

## 2. 循环

1. 派 `qa-only` 子代理：给 spec 来源、fixed point、run 目录。它产出 `qa-plan.md`、`report.json` 和证据，返回总结果与失败项 ID。
2. `pass` → 第 6 步；`fail` → 下一步；`blocked` 先判断能否自行补齐环境，不能则停止并报告。
3. 派 `implement` 子代理：一次修完本轮全部已复现缺陷，缺陷 ID 与 `report.json` 对齐，每个缺陷先写复现测试再修。返回 commit SHA。
4. 派 `qa-only` 子代理复验：只跑失败项与相邻回归项，未变化的项目沿用原证据，返回新总结果。
5. 仍有失败 → 回第 3 步。同一缺陷最多 3 轮修复（含 CR 后修复）。到上限时停止，在报告写明未通过项、尝试次数和剩余问题，交人工判断。
6. 全绿后派 `code-review` 子代理：fixed point 取本轮**首次修复前**的 HEAD，审整轮修复 diff，分别看规范与需求。
7. 有效 findings 转成新缺陷（新 ID）回第 3 步；没有有效 findings 结束。

## 3. 子代理契约

每次派发都必须给：run 目录、fixed point、被测 HEAD、只与它相关的 `qa-plan.md` 条目或 spec 来源、期望返回的结构。子代理自己读取 spec 全文、diff、截图和日志。

主代理只接收：总结果、失败项 ID、commit SHA、证据路径、审查 findings 摘要。不转述截图内容，不复制 diff。

## 4. 委派判据

上下文重（spec、diff、截图、日志）、可独立完成、不影响主代理判断，三条同时成立才交给子代理。缺一条就在主代理内处理，不为委派而拆票。

## 5. 状态文件

`qa-loop.json` 最小字段：`runId`、`fixedPoint`、`spec`、`head`、`round`、`verdict`、`defects[{id, status, evidence}]`、`rounds[{round, head, verdict, failedChecks}]`。每轮追加一条 `rounds`；`defects` 的 `status` 取 `open`、`fixed`、`wontfix`。

## 6. 结束与边界

结束时返回 `report.md` 路径、总结果、已提交 commit 和未解决项。允许 commit，不 push、不建 PR。

`blocked` 保留现场与证据，交调用方准备后重跑。改动范围不含 `.sandcastle/`、workflow 与 CI；云端 QA 仍由 `agent:qa` 阶段 prompt 调度。复验与修复都不改 `qa-plan.md` 的检查 ID。