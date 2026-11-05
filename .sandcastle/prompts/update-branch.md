外层已经尝试把 baseSha 合并到当前 PR 分支，工作区可能留有冲突。检查 git status 和 git diff --name-only --diff-filter=U，逐处阅读两侧历史和意图，保留两侧需求并解决全部冲突。不增加无关功能，不 abort，不 commit；解决后可以 git add，外层会创建保留两个父提交的 merge commit。
无法可靠解决时让执行失败，不发布半成品。输出：{"summary":"合并处理、冲突取舍和验证结果"}。
