# 报告约定

写报告时使用下述字段、判定规则和 Markdown 模板。

## 文件与字段

在本轮产物目录写入 `report.md`、`report.json` 和 `evidence/`。同一 run 复验前保留上一轮报告，使用独立证据文件名；当前报告汇总整份计划的最新结论，沿用证据时保留来源。

`report.json` 是逐项结果的唯一维护源；更新后据此生成 Markdown，避免手工维护两份观察。字段如下：

| 字段 | 内容 |
| --- | --- |
| `spec`、`fixedPoint` | 需求快照、版本及来源；比较基准 SHA |
| `head`、`target` | 当前报告目标 HEAD；`target={head, worktree, environment}` |
| `summary`、`verdict` | 状态计数及实际总结果，由当前有效 checks 与覆盖表计算 |
| `coverage` | `{specReference, checkIds, scope, reason}`；逐条列出需求及本轮范围依据 |
| `checks` | `{id, required, specReference, steps, expected, actual, status, evidence, observedAt, observedTarget, runner, reuseBasis}` |
| `findings` | `{id, checkIds, category, basis, status, reproduction, evidence}`；保留所有缺陷，包括已修、决定不修和撤销的记录 |
| `humanQa` | 人工验收真实状态与证据 |
| `loop` | 仅 `qa` 循环使用：完成状态、停止原因、预算、被验版本与审查摘要；由主代理更新 |

`worktree` 记录受版本控制文件差异快照及相关未跟踪产品文件的路径和内容哈希；干净时明确记 clean。快照包含暂存与未暂存改动，排除 QA 产物及运行临时文件。`environment` 记录入口 / 构建产物、关键配置、工具版本、服务及 fixture 指纹；敏感值使用脱敏标识。仅 HEAD 相同不足以证明目标相同。

每项 `steps` 记录实际执行的命令或交互，`actual` 写观察与副作用。`observedTarget`、`observedAt`、`runner`（路径及版本 / 哈希）绑定原始证据；直接执行时 `reuseBasis=null`，沿用证据时写来源报告、变化核对与仍有效的理由。同一 runner 使用参数选择检查范围，保留其版本以便重放。

证据须脱敏、非空，路径相对产物目录，不含 `..`，解析后仍在该目录内。命名与各 surface 证据要求见 [surface 分派](surfaces.md)。

## 缺陷与误报

`category` 为 `product / documentation / qa / environment / spec-conflict / unknown`；`basis` 引用具体需求、实际操作与分诊依据。`status` 为：

| 状态 | 含义 |
| --- | --- |
| `open` | 尚未解决的有效问题或待查观察。 |
| `fixed` | 修复后独立复验通过。 |
| `wontfix` | 确认有效但决定不修；保留决定依据，必验失败仍记 fail。 |
| `invalidated` | 原判定因错误预期、脚本或 fixture 等撤销，保留纠正依据和重跑证据。 |

范围外问题单列并保留依据。相同问题复发时沿用 ID，新增问题分配新 ID。撤销误报与接受未修缺陷分别记录；修正 QA 产物后，依据新执行结果更新 checks，原始失败留在历史中。

## 证据有效性

目标、spec 或 QA 脚本变化时，先将受影响的旧通过项改为 `not-run`，保留原观察和失效原因，复验后再更新。确证的未解决失败保留 fail；预期无法确定或执行条件缺失时记 blocked。

沿用证据须逐项说明相关代码、需求、输入、环境及 runner 未受变化影响。共享逻辑变化时重跑全部受影响项，影响无法界定时重跑所有必验项。报告目标可以是新版本，但沿用项的 `observedTarget` 保持原值；独立验收确认 `reuseBasis` 后才可计入新目标的结果。

## 判定

| 逐项状态 | 条件 |
| --- | --- |
| `pass` | 实际结果满足预期，有对应证据。 |
| `fail` | 实际观察到违反预期的行为。 |
| `blocked` | 缺少必要环境、明确预期或执行条件。 |
| `not-run` | 尚未执行，或旧通过证据已失效、等待复验。 |

总结果按以下顺序判定：

1. 任一必验项 fail → **fail**。
2. 必验集合非空，全部必验项 pass，且本轮需求覆盖完整 → **pass**。
3. 其余情况，包括空计划、必验项 blocked 或 not-run → **blocked**。

与本轮无关的问题和后续人工验收要求单列，保留人工 QA 的真实状态。

## 交付前一致性核对

用脚本核对 ID、计数、状态和证据路径，从当前 JSON 生成 Markdown；脚本和核对结果保存在本轮产物中。验收代理同时对照 spec 核对覆盖、断言和证据的含义：

- 计划、覆盖表和 checks 的 ID 对齐且唯一；每条范围内需求有相应步骤、断言和有效检查，范围外条目有依据。覆盖缺口记录为 blocked。
- pass 项有真实步骤、实际观察和有效证据；「尚未执行」不能与 pass 并存。`summary`、`verdict` 与逐项状态一致。
- 所有证据路径符合约束，文件存在、非空；沿用证据有原版本和有效性依据。
- Markdown 与 JSON 的结果、目标、缺陷集合及状态一致；使用 `qa` 时再核对 `qa-loop.json`，包括审查新增和撤销的缺陷。缺陷不得因不再失败而从报告消失。
- 最终目标匹配独立验收范围；循环状态满足 [循环状态约定](../qa/loop-state.md)，人工 QA 未执行项仍为待验。不同版本或重复复验的检查数分别记录。

核对未通过时先修正报告；无法补齐证据或覆盖时按实际情况降为 blocked / fail，循环保留未完成。

## Markdown 模板

以下内容写入 `report.md`。

# QA 报告

- Spec：issue URL / 文件路径、版本或读取时间；parent issue 及相关 sub-issues：
- 运行时间、比较基准、目标 HEAD、工作树及环境指纹；独立验收对应版本：
- 入口、环境、服务及测试数据；模拟依赖与证据局限：
- 本轮范围及依据：
- 总结果：pass / fail / blocked
- 循环完成状态、停止原因、已用 / 剩余预算、审查对应版本及结论（只读验收写「不适用」）：

## 需求覆盖

| 需求引用 | 检查 ID | 必验 / 范围外 | 范围依据与覆盖缺口 |
| --- | --- | --- | --- |

## QA plan 与结果

| ID | 必验 | Spec 引用 | 初态、输入与实际操作 | 预期结果 | 实际结果 | 状态 | 证据、被验版本与沿用依据 |
| --- | --- | --- | --- | --- | --- | --- | --- |

## 缺陷

每项记录稳定 ID、关联检查、分类、分诊依据、状态、影响及范围、初始条件、精确复现步骤、预期与实际、重放结果及证据；间歇性问题记录复现条件和频率。保留 fixed / wontfix / invalidated 记录，验收项引用对应 ID。

## 风险项与批准

每项记录稳定 ID、风险操作、为什么必须、影响范围、尝试过的替代方案、批准状态（pending / approved / rejected）、批准来源与时间。未获批的操作不得执行，对应检查记 blocked。

## 未完成项与人工验收

列出 blocked / not-run 的原因、已尝试的准备及恢复方式。人工验收逐项记录真实状态；没有执行的项目保持待验。

## 清理

记录已停止的进程、已清理的资源和保留的测试数据或证据位置。

## 报告核对

记录一致性核对命令、结果、证据位置及未解决问题。
