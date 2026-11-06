// Agent 的结构化输出在生成端和无依赖的发布端使用同一套校验。
const MODES = ['implement', 'implement-prd', 'review', 'implement-pr', 'update-branch', 'to-issues', 'architecture'];
const MUTATING = ['implement', 'implement-prd', 'review', 'implement-pr', 'update-branch'];
function text(value, name, max = 45000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 格式错误。`);
  return value;
}
function validateResult(mode, value) {
  if (!MODES.includes(mode) || !value || typeof value !== 'object') throw new Error('任务结果格式错误。');
  if (JSON.stringify(value).length > 60000) throw new Error('结果超过 GitHub 评论长度限制。');
  const summary = text(value.summary, 'summary');
  if (mode === 'to-issues') {
    if (!Array.isArray(value.slices) || value.slices.length < 1 || value.slices.length > 30) throw new Error('需要1至30项任务。');
    const slices = value.slices.map((slice, index) => {
      if (!Array.isArray(slice.acceptanceCriteria) || !slice.acceptanceCriteria.length || slice.acceptanceCriteria.length > 30) throw new Error('缺少验收条件。');
      const execution = slice.execution;
      if (execution !== 'agent' && !(execution === 'human-qa' && index > 0 && index === value.slices.length - 1)) throw new Error('实现任务须由 Agent 执行；人工 QA 只能作为最后一项。');
      if (!Array.isArray(slice.blockedBy) || new Set(slice.blockedBy).size !== slice.blockedBy.length
        || slice.blockedBy.some((n) => !Number.isSafeInteger(n) || n < 1 || n > index)) throw new Error('依赖必须指向前面的任务且不能重复。');
      if (execution === 'human-qa' && (slice.blockedBy.length !== index || !/^QA\s*:/i.test(slice.title ?? ''))) throw new Error('最终 QA 必须依赖所有实现任务，标题以 QA: 开头。');
      const result = { title: text(slice.title, 'title', 200), execution, blockedBy: slice.blockedBy, whatToBuild: text(slice.whatToBuild, 'whatToBuild', 15000), acceptanceCriteria: slice.acceptanceCriteria.map((x) => text(x, '验收条件', 2000)) };
      if (/\b(?:closes?|fix(?:es)?|resolves?)\s+#\d+/i.test(JSON.stringify(result))) throw new Error('子任务不能包含自动关闭 Issue 的指令。');
      return result;
    });
    return { summary, slices };
  }
  if (mode === 'architecture') {
    if (value.status === 'skipped') return { summary, status: 'skipped' };
    if (value.status !== 'proposed') throw new Error('架构审查状态错误。');
    return { summary, status: 'proposed', title: text(value.title, 'title', 200), body: text(value.body, 'body') };
  }
  if (mode === 'implement-prd' && value.completed !== true) throw new Error('子任务未完成，停止关闭和推进。');
  const comments = value.inlineComments ?? [];
  const replies = value.replies ?? [];
  if (!Array.isArray(comments) || comments.length > 50 || !Array.isArray(replies) || replies.length > 100) throw new Error('评论数量错误。');
  const metadata = {};
  if (value.prTitle !== undefined) metadata.prTitle = text(value.prTitle, 'prTitle', 200);
  if (value.prBody !== undefined) {
    metadata.prBody = text(value.prBody, 'prBody');
    if (/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|https?:)/i.test(metadata.prBody)) throw new Error('PR 关闭引用由发布端管理。');
  }
  return { summary, ...metadata, completed: value.completed === true,
    inlineComments: comments.map((c) => {
      if (!Number.isSafeInteger(c.line) || c.line < 1) throw new Error('行号格式错误。');
      return { path: text(c.path, 'path', 500), line: c.line, body: text(c.body, 'body', 10000) };
    }),
    replies: replies.map((r) => {
      if (!Number.isSafeInteger(r.commentId) || r.commentId < 1) throw new Error('回复 ID 格式错误。');
      return { commentId: r.commentId, body: text(r.body, 'body', 10000) };
    }),
  };
}
function diffLines(patch) {
  const files = new Map();
  let lines;
  let line = 0;
  for (const row of patch.split('\n')) {
    if (row.startsWith('+++ b/')) { lines = new Set(); files.set(row.slice(6), lines); }
    else if (row.startsWith('+++ ')) lines = undefined;
    else if (row.startsWith('@@ ')) line = Number(row.match(/\+(\d+)/)?.[1] ?? 0);
    else if (row.startsWith('+') || row.startsWith(' ')) { lines?.add(line); line++; }
  }
  return files;
}
function reviewPayload(result, patch, sha) {
  const lines = diffLines(patch);
  const inline = result.inlineComments.filter((c) => lines.get(c.path)?.has(c.line));
  const other = result.inlineComments.filter((c) => !lines.get(c.path)?.has(c.line));
  return { event: 'COMMENT', commit_id: sha,
    body: [result.summary, ...other.map((c) => `${c.path}:${c.line}\n${c.body}`)].join('\n\n').slice(0, 60000),
    comments: inline.map((c) => ({ ...c, side: 'RIGHT' })),
  };
}
module.exports = { MODES, MUTATING, validateResult, diffLines, reviewPayload };
