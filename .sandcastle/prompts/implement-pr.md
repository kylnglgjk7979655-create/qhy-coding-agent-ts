# TASK

处理 feedback 中尚未解决的 PR 反馈。区分需要修改、需要解释和无须操作的评论；只处理有关范围。先复现可疑错误，再实施修复和回归验证。可依据证据拒绝建议并解释理由，没有修改需要时允许无变更。

replies 使用输入提供的 thread 评论数字 id，不替审核者 resolve thread。
输出 <output>{"summary":"修改、验证、未采纳建议及理由","completed":true,"replies":[]}</output>。
