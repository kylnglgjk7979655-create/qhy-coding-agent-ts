const MARKER = '<!-- agent-subscription-queue:v1 ';
const ROUTES = {
  implement: { workflow: 'agent-implement.yml', label: 'agent:implement', target: 'issue_number' },
  'implement-pr': { workflow: 'agent-implement-pr.yml', label: 'agent:implement', target: 'pr_number', sha: true },
  review: { workflow: 'agent-review.yml', label: 'agent:review', target: 'pr_number', sha: true },
  'update-branch': { workflow: 'agent-update-branch.yml', label: 'agent:update-branch', target: 'pr_number', sha: true },
  explore: { workflow: 'agent-explore.yml', label: 'agent:explore', target: 'issue_number', extra: ['dry_run'] },
  split: { workflow: 'agent-to-issues.yml', label: 'agent:to-issues', target: 'issue_number' },
  'publish-tickets': { workflow: 'agent-publish-tickets.yml', label: 'agent:publish-tickets', target: 'issue_number', extra: ['approved_at'] },
};

function encodeRequest(request) {
  return `${MARKER}${Buffer.from(JSON.stringify(request)).toString('base64')} -->`;
}

function assertSafeInputs(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'authorization_label' && /(?:auth|token|secret|password|credential)/i.test(key)) {
      throw new Error(`队列输入 ${path}${key} 包含敏感字段，拒绝持久化。`);
    }
    assertSafeInputs(child, `${path}${key}.`);
  }
}

function decodeRequest(body) {
  const match = body.match(/<!-- agent-subscription-queue:v1 ([A-Za-z0-9+/=]+) -->/);
  if (!match || match[1].length > 16_000) return undefined;
  try {
    const request = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (request.version !== 1 || typeof request.id !== 'string' || request.id.length > 300
      || !Number.isSafeInteger(request.number) || request.number < 1 || typeof request.workflow !== 'string'
      || !request.inputs || typeof request.inputs !== 'object' || Array.isArray(request.inputs)
      || !Number.isFinite(Date.parse(request.queuedAt))
      || !['waiting', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(request.status)) return undefined;
    if (!isValidRoute(request)) return undefined;
    return request;
  } catch { return undefined; }
}

function isValidRoute(request) {
  const route = ROUTES[request.kind];
  if (!route || request.workflow !== route.workflow || request.inputs.authorization_label !== route.label
    || request.inputs[route.target] !== String(request.number)) return false;
  const allowed = new Set([route.target, 'authorization_label', ...(route.sha ? ['expected_head_sha'] : []), ...(route.extra || [])]);
  if (Object.keys(request.inputs).some((key) => !allowed.has(key))
    || Object.values(request.inputs).some((value) => typeof value !== 'string')) return false;
  if (route.sha && (!request.inputs.expected_head_sha || !/^[a-f0-9]{40}$/i.test(request.inputs.expected_head_sha))) return false;
  if (request.kind === 'explore' && !['true', 'false'].includes(request.inputs.dry_run)) return false;
  if (request.kind === 'publish-tickets' && !Number.isFinite(Date.parse(request.inputs.approved_at))) return false;
  return true;
}

function renderRequest(request) {
  const state = {
    waiting: '等待订阅执行', running: '正在执行', paused: '订阅认证异常，队列已暂停', completed: '已完成',
    failed: '执行失败，需人工处理后重新授权', cancelled: '已取消或授权已撤销',
  }[request.status];
  const run = request.runUrl ? `\n关联运行：${request.runUrl}` : '';
  const reason = request.reason ? `\n原因：${request.reason}` : '';
  const feedback = request.feedback ? `\n${request.feedback}` : '';
  return `${encodeRequest(request)}\n订阅任务 #${request.number}（${request.kind}）：${state}。${run}${reason}${feedback}`;
}

async function commentsFor(github, context, number) {
  const data = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: number, per_page: 100,
  });
  return data;
}

async function enqueue({ github, context, request }) {
  assertSafeInputs(request.inputs);
  if (!isValidRoute({ ...request, status: 'waiting' })) throw new Error('队列任务类型、授权标签或输入参数不匹配，拒绝保存。');
  const comments = await commentsFor(github, context, request.number);
  const existing = comments.find((comment) => comment.user?.login === 'github-actions[bot]' && decodeRequest(comment.body)?.id === request.id);
  if (existing) return { id: request.id, commentId: existing.id, duplicate: true };

  const record = {
    version: 1,
    id: request.id,
    kind: request.kind,
    number: request.number,
    workflow: request.workflow,
    inputs: request.inputs,
    queuedAt: request.queuedAt || new Date().toISOString(),
    status: 'waiting',
    ...(request.feedback ? { feedback: request.feedback } : {}),
  };
  const { data } = await github.rest.issues.createComment({
    ...context.repo, issue_number: record.number, body: renderRequest(record),
  });
  return { id: record.id, commentId: data.id, duplicate: false };
}

async function listWaiting({ github, context }) {
  const records = await listRecords({ github, context });
  const terminal = new Set(records.filter((entry) => entry.request.status !== 'waiting').map((entry) => entry.request.id));
  return uniqueInOrder(records.filter((entry) => entry.request.status === 'waiting' && !terminal.has(entry.request.id)));
}

function uniqueInOrder(records) {
  const unique = new Map();
  for (const entry of records) {
    const prior = unique.get(entry.request.id);
    if (!prior || entry.commentId < prior.commentId) unique.set(entry.request.id, entry);
  }
  return [...unique.values()].sort((a, b) => a.request.queuedAt.localeCompare(b.request.queuedAt)
    || a.request.id.localeCompare(b.request.id));
}

async function listStatus({ github, context, status }) {
  const records = await listRecords({ github, context });
  return uniqueInOrder(records.filter((entry) => status === '*' || entry.request.status === status));
}

async function listRecords({ github, context }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'all', per_page: 100,
  });
  const records = [];
  for (const issue of issues) {
    const comments = await commentsFor(github, context, issue.number);
    for (const comment of comments) {
      if (comment.user?.login !== 'github-actions[bot]') continue;
      const request = decodeRequest(comment.body);
      if (request) records.push({ request, commentId: comment.id, url: issue.html_url });
    }
  }
  return records.sort((a, b) => a.request.queuedAt.localeCompare(b.request.queuedAt)
    || a.request.id.localeCompare(b.request.id));
}

async function transition({ github, context, number, commentId, status, runUrl, runId, reason, authFingerprint }) {
  const comments = await commentsFor(github, context, number);
  const comment = comments.find((entry) => entry.id === commentId && entry.user?.login === 'github-actions[bot]');
  const request = comment && decodeRequest(comment.body);
  if (!request) throw new Error(`找不到订阅队列请求 ${commentId}。`);
  const allowed = {
    waiting: ['running', 'paused', 'cancelled'], running: ['running', 'completed', 'failed', 'cancelled'],
    paused: ['waiting'], completed: [], failed: [], cancelled: [],
  };
  if (!allowed[request.status].includes(status)) throw new Error(`队列请求不能从 ${request.status} 转为 ${status}。`);
  const updated = { ...request, status, ...(runUrl ? { runUrl } : {}), ...(runId ? { runId } : {}), ...(reason ? { reason } : {}) };
  if (status === 'paused' && authFingerprint) updated.authFingerprint = authFingerprint;
  if (status === 'waiting') { delete updated.reason; delete updated.authFingerprint; }
  // Concurrent duplicate deliveries can race past enqueue's lookup. Resolve every
  // copy together so one event ID still produces a single execution.
  const duplicates = comments.filter((entry) => entry.user?.login === 'github-actions[bot]' && decodeRequest(entry.body)?.id === request.id);
  for (const duplicate of duplicates) await github.rest.issues.updateComment({
    ...context.repo, comment_id: duplicate.id, body: renderRequest(updated),
  });
  return updated;
}

module.exports = { assertSafeInputs, decodeRequest, encodeRequest, renderRequest, enqueue, listStatus, listWaiting, transition };
