# Surface 分派

每条 QA 检查在计划里标注一个 `surface`，执行时按本表选择工具。Midscene 支持什么，验收就能覆盖什么。

| surface | 技能 | 调用入口 | 证据 |
| --- | --- | --- | --- |
| web | `browser-automation` | `npx -y @midscene/web@1 connect`，随后 `act` / `assert` / `take` | 页面截图 |
| android | `android-device-automation` | `npx -y @midscene/android@1 ...`，`--device-id` 指定设备 | 设备截图 |
| ios | `ios-device-automation` | `npx -y @midscene/ios@1 ...` | 设备截图 |
| harmony | `harmonyos-device-automation` | `npx -y @midscene/harmony@1 ...` | 设备截图 |
| desktop | `computer-automation` | `npx -y @midscene/computer@1 ...`，先 `list` 选目标窗口 | 窗口截图 |
| native | 无（直接用产品入口） | `node dist/cli.js ...`；交互式用 PTY（`script -qefc`） | exit code、stdout、stderr、文件副作用 |

## 规则

- 一个检查只有一个执行 surface；需要渲染证据时用 `desktop` 追加，判定仍以该检查的原生观察为准。
- 视觉断言只写可复述、稳定的条件；"看起来正常"不能作为预期。
- 前置条件缺失（`MIDSCENE_MODEL_API_KEY`、`MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_FAMILY` 任一未设，设备未连接，依赖未安装）时，该项记 `blocked`，不记 `fail`。
- 本地运行 `computer-automation` 会接管真实鼠标和键盘：先用 `list` 确认目标窗口，执行完 `disconnect`；能靠终端输出判断的检查不要走桌面。
- 证据命名 `evidence/<检查 ID>-<步骤序号>.<png|log|json>`，必须非空；失败项保留操作前后截图。
- 同一 surface 的多步操作复用一次 `connect` 会话，结束时 `disconnect`。