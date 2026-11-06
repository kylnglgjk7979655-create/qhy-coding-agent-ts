# TASK

修复任务 JSON 中 issue 报告的缺陷。parent（若有）提供背景，范围以当前 Issue 为准。先证明复现和根因，再修复；保留既有行为，回归测试必须能捕获原始症状。

# RESULT

输出 <output>{"summary":"复现命令及 RED 证据、已证实根因、修复和 GREEN 结果、完整检查结果","completed":true}</output>。阻塞时 completed:false。
