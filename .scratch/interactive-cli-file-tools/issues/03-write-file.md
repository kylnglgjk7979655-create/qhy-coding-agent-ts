# 03: 写入工作区文件并完成修改对话

**What to build:** 用户可以要求 Agent 根据读取到的 workspace 文件内容修改文件。Agent 直接写入完整的新内容，并在收到写入结果后完成回答；写入错误会返回给 Agent 解释或继续处理。

**Blocked by:** 02: 读取工作区文件并基于内容回答.

**Status:** ready-for-agent

- [ ] Agent 提供 `write_file` 工具，使用传入内容完整替换目标文件内容；文件不存在时可创建文件。
- [ ] 文件写入复用 `read_file` 的 workspace 路径边界：相对路径从 workspace 解析，绝对路径仅允许落在 workspace 内，符号链接不能越界。
- [ ] workspace 内写入无需逐次确认；终端只显示 `write_file` 工具名称，不显示路径参数或工具结果。
- [ ] 父目录不存在时写入失败，不自动创建父目录；错误作为工具结果交回 Agent。
- [ ] Agent 收到成功或失败的写入结果后继续工具循环，并向用户给出最终答复。
- [ ] 使用编译后的 CLI、本地 provider fixture 和临时 workspace 验证文件完整替换、缺失父目录、越界拒绝、错误回传及写入后的最终回答。
