# 工具执行框架最终审查

日期：2026-11-04。审查基点：集成提交 `22dd4ae`。

## Standards

- 原始发现（判断项 1）：`src/agent.ts` 的三个 SSE 处理循环重复查找事件边界、提取完整事件并消费缓冲区。该重复逻辑易于分歧，属于可维护性改进项；未发现硬性标准违规。
- 修复结果：提取局部 `consumePendingEvents(controller)` helper 复用边界消费逻辑。各调用点仍保留原先逐事件 emit 和 return 时机，文本流可在 HTTP 响应结束前继续交付。

## Spec

- 原始发现（P1，1 项）：`src/agent.ts` 只在 `finishReason === 'tool-calls'` 且步数达到上限时抛出 `STEP_LIMIT`。兼容的提供方可用 `finish_reason: 'stop'` 返回实际工具调用；当 `maxSteps=1` 时，这会绕过步数耗尽错误，转而报告 `PROVIDER_ERROR`，或在伴有文本时把未完成轮次当作成功。
- 修复结果：在步数达到上限且最后一步仍包含工具调用时报告 `STEP_LIMIT`，不增加模型循环。新增编译 CLI + 本地 HTTP fixture 回归，覆盖 stop、非空文本和实际工具调用；确认失败轮不保存且 CLI 可继续下一条输入。

## 验证

- `pnpm check`：通过，类型检查、构建及 5 个测试文件共 69 项测试。
- `git diff --check becf2db...HEAD`：通过。
- 真实模型 smoke：未运行。
