# 交互式 CLI Midscene QA

`interactive-cli.yaml` 使用 Midscene 的旧版 YAML runner（`@midscene/cli`，官方目前将该格式列为维护模式）。脚本操作真实桌面的终端；执行期间请勿使用鼠标键盘。Midscene 的视觉模型需要单独配置；这些凭据不属于被测 CLI。不要把凭据写入文件或提交到仓库。

## 运行

1. 安装项目依赖并运行 `pnpm build`。另行安装 `@midscene/cli` 和 `@midscene/computer`，并按 Midscene 文档配置视觉模型及桌面权限。
2. 在仓库根目录运行 `pnpm exec node qa/midscene/fixture.mjs`，保持该进程运行。它会在临时目录创建独立工作区、人工审批配置和只监听本机的模拟模型，并打印一条启动命令。
3. 在前台终端执行打印出的启动命令，等待 CLI 提示符。使用足够大的终端窗口，确保关键状态可见。执行 `midscene qa/midscene/interactive-cli.yaml`；脚本假定当前为新会话，审批编号从 1 开始。重复运行请重新启动夹具并使用新目录。
4. 脚本结束后检查夹具打印的目录：`approved.txt` 内容应为 `approved-content`，`denied.txt` 不应存在。输入 `/exit` 退出被测 CLI，停止夹具并清理临时目录。

YAML 通过屏幕验证回复、工具状态、批准、拒绝和错误恢复；截图无法保证整个终端历史没有日志。`pnpm check` 包含程序化的非交互日志和终端测试。启动错误、混合 TTY、检查点警告不由此 YAML 覆盖。

本夹具不会请求真实模型服务，不能代替真实模型验收；真实模型可能产生不同文本或工具调用。Midscene 生成的报告可能包含屏幕上可见的信息，分享前应检查并脱敏。
