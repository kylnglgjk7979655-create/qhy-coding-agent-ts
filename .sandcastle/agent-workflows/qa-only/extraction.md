只根据本会话已执行并记录的验收结果，输出一个 `<output>` block。使用中文描述，不执行命令，不修改文件，不重新进行验收。

```json
<output>
{
  "spec": "实际使用的 spec 来源、版本或读取时间",
  "summary": "说明范围、环境、已运行内容及未完成部分",
  "checks": [
    {
      "id": "QA-001",
      "specReference": "issue 编号及具体 acceptance criterion，或 spec 文件条目",
      "steps": "fixture 初态、输入和精确执行步骤",
      "expected": "执行前确定的预期结果",
      "actual": "实际观察；未执行时填写阻塞或未执行原因",
      "status": "pass",
      "evidence": ["checks/QA-001.log"]
    }
  ],
  "findings": [],
  "humanQa": []
}
</output>
```

status 仅可为 pass、fail、blocked、not-run。checks 必须保留所有本轮必验项，包括失败、受阻和未执行项；无 spec、完全无法形成计划时可以为空，总结果将为 blocked。

evidence 引用本次 Artifacts directory 内已存在的非空脱敏文件，使用相对路径。缺少实际运行证据的项目不能是 pass / fail。findings 记录范围外问题；humanQa 逐项保留人工 QA 的真实状态。

不要生成 overall verdict，由程序根据所有 checks 计算。block 外不输出其他内容。
