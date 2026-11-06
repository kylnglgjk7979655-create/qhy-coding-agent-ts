# TASK

外层已尝试将 baseSha 合并到当前 PR 分支，可能留下冲突。检查 git status 和未解决文件，阅读两侧历史及需求，解决全部冲突并保留双方行为。可以 git add；保持 HEAD，外层创建保留两个父提交的 merge commit。

验证最终整合后的代码。无法可靠解决时输出 completed:false，说明冲突及所缺决策。
输出 <output>{"summary":"冲突处理、取舍和验证证据","completed":true}</output>。
