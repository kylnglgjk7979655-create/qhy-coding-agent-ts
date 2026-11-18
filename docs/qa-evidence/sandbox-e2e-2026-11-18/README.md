# Bash 沙箱 macOS E2E 验收证据（2026-11-18）

本目录记录 Bash 沙箱 v1（父需求 #136，交付 PR #147）在真实 macOS Seatbelt 环境下的端到端复验结果。

## 结论

- **E2E 场景：29/29 通过，0 失败**。覆盖 SBX-01–19、SBX-21–27，另含临时目录清理的失败/超时分支和真实 TTY 人工审批场景。
- **完整基线：`pnpm check` 通过**，69 个测试文件通过、1 个跳过；841 项测试通过、13 项跳过。
- 白名单网络实测 `https://example.com` 返回 HTTP 200；域名、端口、危险地址三类代理拒绝均返回稳定原因码。
- 未发现新的产品缺陷。

## 环境

| 项 | 值 |
| --- | --- |
| 提交 | `1909133dde066b170e53a5ef1c571439d9581917`（`main`） |
| 平台 | macOS 26.6.2（25G83）· arm64 |
| Node.js | 24.22.2（仓库 `.npmrc` 锁定版本） |
| pnpm | 9.12.3 |
| Seatbelt | `sandbox-exec -p '(version 1) (allow default)' /usr/bin/true` 探测成功 |
| 执行日期 | 2026-11-18 |

## 方法

每个场景启动一次编译后的真实 CLI（`dist/cli.js`），并满足以下隔离条件：

- 工作区、`HOME`、`TMPDIR`、工作区外目录均为一次性临时目录，测试后删除；
- 模型由本地 OpenAI 夹具提供，按提示词返回精确的 `Bash` 工具调用，不调用外部模型服务；
- 审批使用本地审批模型自动批准；最后一个 PTY 场景切换到人工审批，通过真实 TTY 菜单选择“批准本次”；
- 沙箱执行使用真实 `sandbox-exec`；网络经本机 CONNECT 代理；
- 断言读取模型实际收到的工具结果 JSON、审批载荷中的 `sandboxExecution` / `sandboxBypass` / `sandboxNotice`，以及磁盘文件状态。

## 分组结果

| 组 | 配置 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| A | 启用沙箱、`onUnavailable: closed`、读写白/黑名单、网络白名单、豁免排除表 | SBX-01–18、SBX-13F/13T、SBX-21–22、SBX-27 | 全部通过 |
| B | `enabled: false` | SBX-24 | 通过 |
| C | `networkAllow: []` | SBX-19 | 通过 |
| D | 受限 `PATH`（无 `sandbox-exec`）+ `closed` | SBX-25 | 通过 |
| E | 受限 `PATH` + `open` | SBX-26 | 通过 |
| F | `permissions.deny` + `bypassAllowedCommands` | SBX-23 | 通过 |
| PTY | 真实 TTY 人工审批菜单 | SBX-PTY | 通过 |

## 关键结果

- **隔离与读写**：`sandboxed: true`；工作区、`$TMPDIR`、`writePaths` 可写；工作区外与 `writeDenyPaths` 写入被拒；`~/.ssh` 拒读且未泄露内容；符号链接不能绕过拒读；5 类防篡改路径均未创建。
- **最小环境**：仅 `envPassthrough` 中的变量进入沙箱子进程，宿主变量不可见。
- **网络代理**：三个代理变量同端口；白名单目标 HTTP 200；`host-not-allowed`、`port-not-allowed`、`dangerous-address` 均按预期出现；未配置网络时无代理变量且直连失败。
- **豁免与权限**：豁免获准在宿主执行并标记 `sandboxed: false`；复合命令豁免未获准仍留在沙箱内；固定 `permissions.deny` 优先于豁免且不进入审批；关闭沙箱时豁免显示“已忽略（沙箱未启用）”。
- **不可用策略**：fail-closed 在启动命令前拒绝且文件未创建；fail-open 实际在宿主执行并带“未隔离”说明。
- **清理**：成功、失败、超时三种路径均未残留 `qhy-sandbox-*` 临时目录。

## 截图

1. [总览](./01-overview.png)：29/29、环境、分组结果与全部场景。
2. [隔离与读写边界](./02-isolation-readwrite.png)：工作区/TMPDIR/白名单写入，外部与 writeDeny 拒绝，清理分支。
3. [敏感读取与防篡写](./03-read-deny-tamper.png)：`~/.ssh`、readAllow 精确回补、符号链接、5 类防篡改路径。
4. [CONNECT 代理与出站策略](./04-network-proxy.png)：HTTP 200 与三类拒绝原因码。
5. [豁免、权限与沙箱不可用](./05-bypass-unavailable.png)：获准/未获准、deny 优先、fail-open/closed。
6. [真实 TTY 人工审批](./06-manual-approval.png)：审批菜单显示“沙箱内执行”，批准后命令成功。

原始逐项断言与工具结果见 [results.json](./results.json)，PTY 原始会话见 [SBX-PTY.transcript.txt](./SBX-PTY.transcript.txt)。

## 未覆盖与限制

- **SBX-20（代理启动失败）**：无法通过产品配置稳定制造，未纳入本轮人工 E2E；该路径由 `tests/sandbox-execution.test.ts` 自动化覆盖，因此不声称已人工验收。
- **取消路径**：本轮人工 E2E 覆盖成功、失败、超时三种临时目录清理；取消路径仍以自动化测试为准。
- **PTY 审批**：由脚本驱动真实 TTY 菜单并输入 `1` + 回车，不是人亲自点击；这是对交互路径的真实运行验证，但不是人工手工验收记录。
- 本证据不改变 `docs/qa-tool-capabilities.md` 中“macOS 人工 QA 待人工确认”的既有判定；它补充的是一次独立、可复现的端到端运行结果。

## 复现要点

使用仓库锁定的 Node.js 24.22.2 与 pnpm 9.12.3：

```sh
pnpm install --frozen-lockfile
pnpm build
VITEST_MAX_WORKERS=2 pnpm check
```

E2E 夹具位于仓库外，仅写入一次性临时目录；场景配置与 `docs/qa-tool-capabilities.md` 的 macOS 验收配置一致。逐项断言记录在 `results.json`。