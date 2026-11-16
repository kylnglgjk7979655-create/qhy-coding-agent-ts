# 增加 Claude 风格文件、待办与网络工具

## 决策

内置工具补齐为 `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`、`TodoWrite`、`WebFetch` 和 `WebSearch`；名称与参数参考 Claude Code。`read_file`、`write_file`、`glob`、`grep` 和 `Bash` 保留为兼容入口，避免既有会话与权限配置失效。`Read` 使用 `file_path`、`offset`、`limit`；`Write` 使用 `file_path`、`content`；`Edit` 使用 `file_path`、`old_string`、`new_string` 和默认 `false` 的 `replace_all`。

`Edit` 在单个文件内精确匹配文本。默认要求唯一匹配；无匹配或多处匹配时失败且不修改文件；`replace_all: true` 时替换全部匹配。`Write` 与 `Edit` 在同一进程写入门闩内检查读取基线：已读取文件变化时拒绝写入；`Write` 允许直接创建或重写尚未预读的目标，旧 `write_file` 仍要求先读取。两者沿用既有写入检查点与备份回调。

`TodoWrite` 保存本次 Agent 运行内的待办列表。每次调用以完整列表替换旧状态，最多允许一个 `in_progress`；不写磁盘、不跨运行共享，也不访问网络。

`WebFetch` 只允许公开 HTTP/HTTPS 地址。执行前解析主机，拒绝回环、私网、链路本地、云 metadata、保留地址以及 `localhost`、`.local`、`.internal` 等名称；每次重定向重新解析和校验。请求使用 30 秒独立超时，响应正文最多 5 MiB，返回内容最多 100,000 字符，仅接受文本类内容类型。地址无效、被拒绝、网络失败、超时或内容类型不支持时返回明确的工具错误。

`WebSearch` 首期接入 Tavily。API Key 从 `webSearch.apiKeyEnv` 指定的环境变量读取，默认 `TAVILY_API_KEY`；缺失时只在调用时返回明确错误，不阻止 CLI 启动或其他工具。搜索服务通过 `WebSearchProvider` 接口解耦，以便后续增加其他提供方。凭据不进入工具参数、日志或会话记录。

## 权限与审批

新增工具继续使用统一 `permissions` 与逐次审批：

- `Read`、`Write`、`Edit`、`Glob`、`Grep` 按路径匹配，`Edit` 使用 `Write` 能力；
- `WebFetch` 可按完整主机或 `domain:` 模式匹配，`WebSearch` 与 `TodoWrite` 使用不带参数的能力规则；
- `Edit`、`Write` 默认进入审批；`WebFetch`、`WebSearch` 未配置规则时默认进入审批；`TodoWrite` 默认允许。

网络工具只提供应用层策略，不替代操作系统隔离；Bash 沙箱仍只约束沙箱内执行的 Bash 进程。

## 测试影响

新增工具定义进入上下文预算估算，固定小容量压缩用例需要为完整工具定义保留空间。测试使用 `capacityTokens: 21200` 等显式容量维持原触发时机；产品默认容量不变。网络测试使用本机回环服务验证拒绝与 Tavily 兼容响应，不需要真实 Tavily 凭据。