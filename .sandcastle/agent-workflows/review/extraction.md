Emit a single `<output>` block as the last thing in your response.

Do not change files.
Do not run commands.
Do not include text outside the `<output>` block.

```json
<output>
{
  "summary": "1-3 paragraphs explaining your review, including what you changed or why it was already clean.",
  "reviewedHead": "实际完成最终 PR Review 的完整提交 SHA",
  "requiredEvidence": ["screenshot", "recording"],
  "checks": {
    "standards": { "status": "PASS", "details": "规范审查结论" },
    "spec": { "status": "PASS", "details": "需求审查结论" },
    "bugs": { "status": "PASS", "details": "回归审查结论" },
    "verification": { "status": "PASS", "details": "运行场景、结果、截图或录屏文件名" }
  },
  "inlineComments": [
    { "path": "relative/file.ts", "line": 123, "body": "Markdown comment" }
  ],
  "replies": [
    { "commentId": "GraphQL node id from PR_COMMENTS_JSON", "body": "Markdown reply" }
  ]
}
</output>
```

Use empty arrays when there are no inline comments or replies.

四项均需填写实际结果，状态为 `PASS`、`FAIL`、`BLOCKED` 或 `SKIP`。缺少适用的截图或录屏、未执行、未获得结论或结果过期时记为 `BLOCKED`。仅不适用时可填 `SKIP`，并在 details 说明原因。汇总中同时记录简化判断及理由。

`requiredEvidence` 列出当前改动适用的证据类型，即使本次未取得文件也要列出。涉及 UI 操作列出 `screenshot`，涉及端到端测试列出 `recording`。两者均不适用时用空数组。
