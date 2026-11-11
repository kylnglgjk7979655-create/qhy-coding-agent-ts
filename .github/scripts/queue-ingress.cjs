const { enqueue } = require('./task-queue.cjs');

const issueRoutes = {
  'agent:implement': ['implement', 'agent-implement.yml'],
  'agent:implement-spec': ['implement-spec', 'agent-implement-spec.yml'],
  'agent:to-issues': ['split', 'agent-to-issues.yml'],
  'agent:explore': ['explore', 'agent-explore.yml'],
};
const prRoutes = {
  'agent:implement': ['implement-pr', 'agent-implement-pr.yml'],
  'agent:review': ['review', 'agent-review.yml'],
  'agent:qa': ['qa', 'agent-qa.yml'],
  'agent:qa-only': ['qa-only', 'agent-qa-only.yml'],
  'agent:update-branch': ['update-branch', 'agent-update-branch.yml'],
};

async function route({ github, context }) {
  const event = context.payload;
  if (context.eventName === 'workflow_dispatch') {
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      ...context.repo, state: 'open', labels: 'agent:explore', per_page: 100,
    });
    const candidates = issues.filter((issue) => !issue.pull_request)
      .sort((a, b) => a.number - b.number);
    const item = candidates[0];
    if (!item) return { ignored: true, reason: '没有携带 agent:explore 的开放 Issue。' };
    const request = {
      id: `manual-explore-${context.runId}`,
      kind: 'explore', number: item.number, workflow: 'agent-explore.yml',
      inputs: { issue_number: String(item.number), authorization_label: 'agent:explore', dry_run: String(event.inputs?.dry_run ?? true) },
    };
    const saved = await enqueue({ github, context, request });
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo, workflow_id: 'agent-queue.yml', ref: 'main', inputs: {},
    });
    return saved;
  }
  const isIssue = context.eventName === 'issues';
  const isPullRequest = context.eventName === 'pull_request_target';
  if (!isIssue && !isPullRequest) return { ignored: true };
  if (event.action !== 'labeled') return { ignored: true };
  const label = event.label?.name;
  const routes = isIssue ? issueRoutes : prRoutes;
  if (!Object.hasOwn(routes, label)) return { ignored: true };
  const item = isIssue ? event.issue : event.pull_request;
  if (isPullRequest && (item.state !== 'open'
    || item.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`)) {
    return { ignored: true, reason: '只接受同仓库的开放 PR。' };
  }
  const [kind, workflow] = routes[label];
  const number = item.number;
  const inputs = {
    authorization_label: label,
    ...(kind === 'explore' ? { issue_number: String(number), dry_run: 'false' }
      : isIssue ? {
        issue_number: String(number),
      } : { pr_number: String(number) }),
    ...(isPullRequest ? { expected_head_sha: item.head.sha } : {}),
  };
  const id = `event-${number}-${label}-${item.updated_at}`;
  const saved = await enqueue({
    github, context,
    request: { id, kind, number, workflow, inputs, queuedAt: context.payload.label?.created_at },
  });
  await github.rest.actions.createWorkflowDispatch({
    ...context.repo, workflow_id: 'agent-queue.yml', ref: 'main', inputs: {},
  });
  return saved;
}

module.exports = { route };
