const { decodeRequest, enqueue } = require('./task-queue.cjs');

const MAX_REPAIRS = 2;
const TEST_STEPS = new Set(['Run pnpm check', 'Run pnpm demo:test']);
const ACTIVE = new Set(['waiting', 'running', 'paused']);

function isManagedPr(pr, repository) {
  return pr.state === 'open' && pr.base.ref === 'main'
    && pr.head.repo?.full_name === repository
    && /^agent\/(issue|parent)-[1-9]\d*$/.test(pr.head.ref)
    && pr.body?.includes('Implemented by the Sandcastle agent workflow.');
}

async function dispatch(github, repo, workflow_id, ref) {
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id, ref, inputs: {} });
}

async function requestCheck(github, context, repository) {
  const { pull_request: pr, action, label } = context.payload;
  if (action !== 'labeled' || label?.name !== 'agent:qa' || !pr || !isManagedPr(pr, repository)) {
    return { ignored: true };
  }
  await dispatch(github, context.repo, 'check.yml', pr.head.ref);
  await github.rest.issues.removeLabel({ ...context.repo, issue_number: pr.number, name: label.name });
  return { dispatched: pr.number };
}

async function handle({ github, context }) {
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  if (context.eventName === 'pull_request_target') return requestCheck(github, context, repository);
  const run = context.payload.workflow_run;
  if (context.eventName !== 'workflow_run' || context.payload.action !== 'completed'
    || run?.name !== 'Check' || run.path !== '.github/workflows/check.yml'
    || run.head_repository?.full_name !== repository || !Number.isSafeInteger(run.id)
    || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')
    || !['success', 'failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) {
    return { ignored: true };
  }

  const { data: pulls } = await github.rest.pulls.list({ ...repo, state: 'open', base: 'main', head: `${repo.owner}:${run.head_branch}` });
  const pr = pulls.find((item) => item.head.sha === run.head_sha && isManagedPr(item, repository));
  if (!pr) return { ignored: true };

  const issue = { ...repo, issue_number: pr.number };
  const comments = await github.paginate(github.rest.issues.listComments, { ...issue, per_page: 100 });
  const botComments = comments.filter((comment) => comment.user?.login === 'github-actions[bot]');
  const records = botComments.map((comment) => decodeRequest(comment.body)).filter(Boolean);
  const labels = pr.labels.map((label) => label.name);
  const repairs = new Set(records.filter((record) => record.id.startsWith('qa-repair-')).map((record) => record.id));
  const repairId = `qa-repair-${run.head_sha}`;
  const runUrl = `${context.serverUrl}/${repository}/actions/runs/${run.id}`;

  let kind;
  let id;
  let feedback;
  if (run.conclusion === 'success') {
    const ready = !pr.head.ref.startsWith('agent/parent-')
      || botComments.some((comment) => comment.body.startsWith('<!-- agent-qa-review -->'));
    if (!ready || labels.includes('agent:blocked') || records.some((record) => record.kind === 'review'
      || (record.kind === 'implement-pr' && ACTIVE.has(record.status)))) return { ignored: true };
    kind = 'review';
    id = `qa-review-${run.head_sha}`;
    feedback = `QA 已通过。 [Check 运行](${runUrl})`;
  } else {
    const priorRepair = records.find((record) => record.id === repairId);
    if (priorRepair && ACTIVE.has(priorRepair.status)) return { duplicate: true };
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
      ...repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
    });
    const step = jobs.flatMap((job) => job.steps ?? []).find((item) => item.conclusion === 'failure');
    const stage = step?.name && /^[\p{L}\p{N} ._/@:-]{1,100}$/u.test(step.name) ? `\`${step.name}\`` : '运行阶段';
    const failure = `QA 失败（${run.conclusion}，${stage}）。 [Check 运行](${runUrl})`;
    const active = records.some((record) => record.kind === 'implement-pr' && ACTIVE.has(record.status));
    if (run.conclusion !== 'failure' || !TEST_STEPS.has(step?.name) || repairs.size >= MAX_REPAIRS
      || priorRepair || active || labels.includes('agent:blocked')) {
      const marker = `<!-- agent-qa-failure:${run.id}:${run.run_attempt} -->`;
      if (!botComments.some((comment) => comment.body.includes(marker))) {
        const reason = priorRepair ? '这一提交已完成一次反馈处理。' : active ? '已有反馈处理任务。'
          : repairs.size >= MAX_REPAIRS ? '自动修复已达到两轮上限。'
          : labels.includes('agent:blocked') ? 'PR 处于阻塞状态。' : '失败发生在自动修复范围之外，需检查运行日志。';
        await github.rest.issues.createComment({ ...issue, body: `${marker}\n${failure}\n${reason}` });
      }
      return { reported: pr.number };
    }
    kind = 'implement-pr';
    id = repairId;
    feedback = `${failure}\n自动修复第 ${repairs.size + 1}/${MAX_REPAIRS} 轮。请检查失败步骤、复现、修复并运行相关测试。`;
  }

  const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (current.head.sha !== run.head_sha || !isManagedPr(current, repository)
    || current.labels.some((label) => label.name === 'agent:blocked')) return { ignored: true };

  const label = kind === 'review' ? 'agent:review' : 'agent:implement';
  await github.rest.issues.addLabels({ ...issue, labels: [label] });
  const saved = await enqueue({ github, context, request: {
    id, kind, number: pr.number, workflow: `agent-${kind}.yml`,
    inputs: { pr_number: String(pr.number), authorization_label: label, expected_head_sha: run.head_sha },
    feedback,
  } });
  await dispatch(github, repo, 'agent-queue.yml', 'main');
  return saved;
}

module.exports = { handle };

