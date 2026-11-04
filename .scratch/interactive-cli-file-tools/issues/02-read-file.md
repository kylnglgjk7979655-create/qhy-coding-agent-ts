# 02: 读取工作区文件并基于内容回答

**What to build:** 用户可在交互对话中要求 Agent 阅读 workspace 中的文件。Agent 能收到文件内容或可处理的错误，并在工具往返后给出回答；终端只展示工具名称。

**Blocked by:** 01: 交互式对话与会话续接.

**Status:** ready-for-agent

- [ ] Agent 提供 `read_file` 工具，可读取普通文件并将内容交回模型继续回答。
- [ ] 相对路径从配置的 workspace 解析；绝对路径仅在解析后的目标仍位于 workspace 内时允许。
- [ ] 越出 workspace 的路径和最终指向 workspace 外部的符号链接被拒绝。
- [ ] 读取错误作为工具结果交给 Agent，让 Agent 能解释问题或继续处理。
- [ ] 工具调用时终端只显示工具名称，不显示路径参数或工具结果。
- [ ] 保留 `runtimeInfo` 工具；真实工具 smoke 改为通过 `read_file` 读取生成的探针，并验证最终模型回复使用探针内容。
- [ ] 使用编译后的 CLI、本地 provider fixture 和临时 workspace 验证文件内容回传、路径边界、错误往返、工具名称展示及 smoke 行为。
