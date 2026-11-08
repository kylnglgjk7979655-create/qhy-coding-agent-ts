Emit a single `<output>` block as the last thing in your response.

Do not change files.
Do not run commands.
Do not include text outside the `<output>` block.

若执行阶段未新增提交，且没有线程回复或行内评论，将执行阶段的无需修改说明放入 `topLevelComments`，至少包含一条非空评论。保留无需修改的原因、对应的已有提交（如有）和实际验证结果；只引用会话中已确认的信息，未执行验证时如实注明。

```json
<output>
{
  "threadReplies": [
    { "commentId": "GraphQL node id from PR_COMMENTS_JSON", "body": "Markdown reply" }
  ],
  "newInlineComments": [
    { "path": "relative/file.ts", "line": 123, "body": "Markdown comment" }
  ],
  "topLevelComments": [
    { "body": "Markdown comment" }
  ]
}
</output>
```

没有对应内容的字段使用空数组；上述无需新增提交且没有其他回复或评论的情况，`topLevelComments` 必须保留说明评论。
