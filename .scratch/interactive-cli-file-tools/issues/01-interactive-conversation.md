# 01: 交互式对话与会话续接

**What to build:** 用户启动 CLI 后无需传入首条消息，就能进入对话，逐条发送消息并在每轮回复后继续输入；输入 `/exit` 退出。新对话生成可用于后续续接的 conversation ID，也能通过现有 ID 恢复历史。成功轮次保存完整消息历史，失败轮次不保存，且失败后仍可继续对话。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] CLI 启动后直接等待终端输入，不要求首条消息作为命令行参数。
- [ ] 每条消息完成模型回答后再接受下一条；输入 `/exit` 正常退出。
- [ ] 沿用现有模型、API key、timeout、`maxSteps`、取消行为和 `runtimeInfo` 能力。
- [ ] 新建对话 ID 可从现有 JSON 日志中获取；传入已有 ID 时恢复历史继续对话。
- [ ] 每个完整成功轮次保存用户消息、工具往返和 Agent 回复；未完成或失败轮次不写入会话历史。
- [ ] 单轮失败时显示错误并继续等待下一条消息。
- [ ] 使用编译后的 CLI 和本地 provider fixture 验证多轮输入、`/exit`、新建与恢复 ID、成功保存、失败不保存及失败后继续输入。
