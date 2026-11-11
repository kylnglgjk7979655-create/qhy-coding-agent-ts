只根据本会话已执行并记录的验收结果，输出一个 `<output>` block。使用中文描述，不执行命令，不修改文件，不重新进行验收。

```json
<output>
{
  "testedHead": "实际最后验收的完整 commit SHA；完全未执行时为 null",
  "reviewedHead": null,
  "reviewSummary": "最后一次修复 CR 的结论；未修复则写无需新增 CR",
  "repairs": [],
  "unresolvedFindings": [],
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

repairs 每项为 {"issue":"问题及复现标识", "attempts":1, "resolved":true, "commits":["完整 commit SHA"]}。同一问题包含所有 implement 和 CR 后的修复尝试，最多三次，不因 subagent 更换而重置。达到三次仍未解决时 resolved=false，并在 unresolvedFindings 写明原因。unresolvedFindings 记录范围内尚未解决的 QA/CR 问题；范围外旧问题放 findings。

仅全部必验项通过、范围内问题已解决，且最后一次修复 CR 通过时才能形成通过结论。testedHead 填最终实际复验的完整 SHA；reviewedHead 填最后一次 CR 通过的完整 SHA，否则为 null。

不要生成 overall verdict，由程序根据所有 checks 计算。block 外不输出其他内容。
