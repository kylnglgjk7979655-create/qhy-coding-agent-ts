# 循环状态

创建和更新 `qa-loop.json` 时使用本约定。它记录调度、预算与缺陷生命周期；逐项观察和证据以 `report.json` 为准。

## 字段

| 字段 | 内容 |
| --- | --- |
| `runId`、`fixedPoint`、`spec` | 本轮标识、比较基准 SHA、需求快照路径与版本 |
| `head`、`target` | 当前目标 HEAD；`target` 含 HEAD、工作树指纹、环境指纹，与报告约定一致 |
| `verifiedTarget` | 最近一次独立验收对应的目标，未验收为 `null`；逐项来源见报告 |
| `crFixedPoint`、`crRounds`、`review` | 固定的审查基准、已派发审查次数、最近审查的 `{target, status, evidence}` |
| `round`、`verdict` | 已派发批量修复次数、实际验收结果（`pass / fail / blocked`） |
| `workflowStatus`、`stopReason` | 循环状态（`running / completed / stopped`）、停止原因或 `null` |
| `startedAt`、`elapsedMs`、`budget` | 起始时间、累计耗时、`{maxRounds, maxCrRounds, maxAttemptsPerDefect, maxElapsedMs}` |
| `defects` | `{id, checkIds, category, basis, status, attempts, evidence}`，与报告 findings 使用相同 ID、分类及状态 |
| `rounds` | `{round, targetBefore, targetAfter, status, attemptedDefects, verdict, failedChecks, commits, report}` |
| `risks` | `{id, action, status}`；批准来源与时间见报告 |

初始化时 `round`、`crRounds`、`elapsedMs` 和缺陷的 `attempts` 为 0；`verdict=blocked`、`workflowStatus=running`，`verifiedTarget`、`crFixedPoint`、`review` 和 `stopReason` 为 `null`。默认预算为 `{maxRounds:3, maxCrRounds:2, maxAttemptsPerDefect:3, maxElapsedMs:3600000}`；调用方指定时记录其来源。

## 更新与预算

派发修复前递增 `round`，增加实际尝试缺陷的 `attempts`，追加 `status=running` 的轮次记录；复验后补齐目标、结果和报告路径，状态改为 `completed`。中断记 `interrupted` 并保留次数。每次派发审查即递增 `crRounds`；首次审查前固定 `crFixedPoint`，之后不变。

每次派发或恢复前，更新累计耗时并检查本次动作的预算：时间限制覆盖所有阶段，修复与审查次数只限制下一次对应动作，不阻止已派发的最后一轮复验和收口。暂停等待也计入整轮时间；恢复同一 run 沿用起始时间和次数，新缺陷共享剩余预算。预算调整须记录调用方指令和前后值。运行中达到时间上限时终止可终止的任务，先保存现场并清理，未完成的检查保持实际状态。

`target` 改变后，更新整份计划中受影响检查的有效性；旧通过证据不能代表新目标。`verifiedTarget` 保留最近实际验收版本，最终由独立验收确认新目标及可沿用的证据。审查状态为 `pass / findings / stale / not-applicable`；`not-applicable` 仅用于已确认无待审产品改动的情况，须记录依据。

## 缺陷与风险

分类、分诊依据和状态使用 [报告中的缺陷约定](../qa-only/report-template.md#缺陷与误报)，包括 `open / fixed / wontfix / invalidated`。

同一问题复发时重开原 ID，保留次数。撤销误报不计为修复成功；后续发现的真实问题使用新 ID。风险状态为 `pending / approved / rejected`，具体操作、批准来源和时间写入报告。

## 结论与恢复

`verdict` 沿用 [报告判定](../qa-only/report-template.md)。`workflowStatus=completed` 仅在最终目标独立验收通过、有效审查通过（或有依据的 `not-applicable`）、覆盖与报告核对通过时使用，同时 `stopReason=all-checks-passed`。

其余停止使用 `workflowStatus=stopped`，原因取 `blocked`、`authorization-required`、`time-budget`、`repair-limit`、`defect-limit`、`review-limit`、`no-actionable-defect` 或 `user-stopped`。停止时按当前目标的有效 checks 重算 `verdict`，受影响项未复验时不能沿用旧版 pass；历史结果保留在 rounds 和来源报告中。即使当前 `verdict=pass`，审查或收口未完成也不能将循环标为 completed。

每轮使用独立证据文件名，保留历史报告与证据；`report.md`、`report.json` 展示当前汇总，`rounds` 保留索引。主代理将完成状态、停止原因、预算与审查摘要写入 `report.json.loop`；登记审查 finding 后同步 `defects`，保留验收代理的实际观察和判定，再生成 Markdown。

恢复时沿用 run 目录、检查与缺陷 ID、次数和预算，先核对 spec、目标与证据有效性；同时校验报告与状态文件的缺陷集合及状态。原已停止原因保留在历史中，满足恢复条件后再设为 running。
