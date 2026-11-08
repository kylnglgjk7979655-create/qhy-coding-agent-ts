const { listStatus, listWaiting, transition } = require('./task-queue.cjs');
const { createHash } = require('node:crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authFingerprint() {
  return createHash('sha256').update(`${process.env.CODEX_AUTH_JSON || ''}\0${process.env.CODEX_AUTH_STORE_PAT || ''}`).digest('hex');
}

async function pauseWaiting(github, context, fingerprint) {
  const waiting = await listStatus({ github, context, status: 'waiting' });
  for (const entry of waiting) await transition({
    github, context, number: entry.request.number, commentId: entry.commentId, status: 'paused',
    authFingerprint: fingerprint,
    reason: '前一任务的订阅认证恢复或回存失败。修复 CODEX_AUTH_JSON / CODEX_AUTH_STORE_PAT 后，调度器会自动恢复。',
  });
}

async function resumePaused(github, context, fingerprint, verified = false) {
  const paused = await listStatus({ github, context, status: 'paused' });
  for (const entry of paused) {
    if (verified || entry.request.authFingerprint !== fingerprint) await transition({
      github, context, number: entry.request.number, commentId: entry.commentId, status: 'waiting',
    });
  }
}

async function stillAuthorized(github, context, request) {
  const { data: source } = await github.rest.issues.get({
    ...context.repo, issue_number: request.number,
  });
  if (source.state !== 'open') return '来源 Issue/PR 已关闭';
  const labels = source.labels.map((label) => typeof label === 'string' ? label : label.name);
  if (!labels.includes(request.inputs.authorization_label)) return '授权标签已移除';
  if (request.inputs.expected_head_sha && source.pull_request) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: request.number });
    if (pr.head.sha !== request.inputs.expected_head_sha) return 'PR 分支已更新，请重新添加执行标签';
    if (pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`) return '不执行 fork PR';
  }
  return undefined;
}

async function findLatestRun(github, context, request) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo, workflow_id: request.workflow, event: 'workflow_dispatch', per_page: 20,
  });
  return data.workflow_runs.sort((a, b) => b.id - a.id)[0];
}

async function jobSteps(github, context, runId) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    ...context.repo, run_id: runId, per_page: 100,
  });
  return data.jobs.flatMap((job) => job.steps ?? []);
}

async function authPersistenceFailed(github, context, runId) {
  const steps = await jobSteps(github, context, runId);
  return steps.some((step) => /(?:Restore Codex subscription|Save refreshed Codex subscription|Persist encrypted login)/.test(step.name)
    && step.conclusion === 'failure');
}

function authRoundTripSucceeded(steps) {
  return ['Restore Codex subscription', 'Save refreshed Codex subscription'].every((name) =>
    steps.some((step) => step.name === name && step.conclusion === 'success'));
}

async function execute(github, context, entry) {
  const { request, commentId } = entry;
  const refusal = await stillAuthorized(github, context, request);
  if (refusal) {
    await transition({ github, context, number: request.number, commentId, status: 'cancelled', reason: refusal });
    return;
  }

  await transition({ github, context, number: request.number, commentId, status: 'running' });
  const previousRun = await findLatestRun(github, context, request);
  try {
    const { authorization_label, ...taskInputs } = request.inputs;
    void authorization_label;
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: request.workflow,
      ref: 'main',
      inputs: { ...taskInputs, queue_request_id: request.id },
    });
  } catch (error) {
    await transition({
      github, context, number: request.number, commentId, status: 'failed',
      reason: `无法启动工作流；修复 Actions 权限后重新添加授权标签。${error.message}`,
    });
    return;
  }

  let run;
  for (let attempt = 0; attempt < 30 && !run; attempt += 1) {
    const latest = await findLatestRun(github, context, request);
    if (latest && latest.id !== previousRun?.id) run = latest;
    if (!run) await sleep(2000);
  }
  if (!run) {
    await transition({
      github, context, number: request.number, commentId, status: 'failed',
      reason: '工作流已派发但无法找到对应运行；请检查 Actions 后手动重新授权。',
    });
    return;
  }
  const runUrl = run.html_url;
  await transition({ github, context, number: request.number, commentId, status: 'running', runUrl, runId: run.id });

  while (run.status !== 'completed') {
    await sleep(15000);
    const { data } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: run.id });
    run = data;
  }
  if (run.conclusion === 'success') {
    await transition({ github, context, number: request.number, commentId, status: 'completed', runUrl });
    if (authRoundTripSucceeded(await jobSteps(github, context, run.id))) {
      await resumePaused(github, context, authFingerprint(), true);
    }
    return false;
  } else {
    const authFailure = await authPersistenceFailed(github, context, run.id);
    await transition({
      github, context, number: request.number, commentId,
      status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', runUrl,
      reason: authFailure
        ? `订阅认证恢复或回存失败，队列已暂停，避免继续使用未确认的登录态。查看 ${runUrl} 修复认证后，重新添加授权标签。`
        : `工作流以 ${run.conclusion} 结束；查看关联运行，处理后重新添加授权标签。`,
    });
    if (authFailure) await pauseWaiting(github, context, authFingerprint());
    return authFailure;
  }
}

async function recoverRunning(github, context) {
  const running = await listStatus({ github, context, status: 'running' });
  let pause = false;
  for (const entry of running) {
    const { request, commentId } = entry;
    if (!request.runId) {
      await transition({
        github, context, number: request.number, commentId, status: 'failed',
        reason: '调度在记录子工作流编号前中断。为避免重复模型或发布动作，未自动重放；请核查 Actions 后重新授权。',
      });
      continue;
    }
    let child;
    try {
      child = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: request.runId })).data;
    } catch {
      await transition({
        github, context, number: request.number, commentId, status: 'failed',
        reason: '找不到关联的子工作流。为避免盲目重放，请核查 Actions 后重新授权。',
      });
      continue;
    }
    while (child.status !== 'completed') {
      await sleep(15000);
      ({ data: child } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: request.runId }));
    }
    const authFailure = child.conclusion !== 'success' && await authPersistenceFailed(github, context, child.id);
    await transition({
      github, context, number: request.number, commentId,
      status: child.conclusion === 'success' ? 'completed' : child.conclusion === 'cancelled' ? 'cancelled' : 'failed',
      runUrl: child.html_url,
      reason: child.conclusion === 'success' ? undefined : authFailure
        ? `订阅认证恢复或回存失败，队列已暂停。查看 ${child.html_url} 修复认证后，重新添加授权标签。`
        : `中断恢复发现子工作流以 ${child.conclusion} 结束；查看关联运行，处理后重新添加授权标签。`,
    });
    if (authFailure) await pauseWaiting(github, context, authFingerprint());
    pause ||= Boolean(authFailure);
  }
  return pause;
}

async function run({ github, context }) {
  // One coordinator holds the repository-wide concurrency lock across the child
  // workflow, including authentication refresh, persistence, and publication.
  const fingerprint = authFingerprint();
  await resumePaused(github, context, fingerprint);
  if (await recoverRunning(github, context)) return;
  const pending = await listWaiting({ github, context });
  if (!pending.length || await execute(github, context, pending[0])) return;
  if ((await listWaiting({ github, context })).length) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo, workflow_id: 'agent-queue.yml', ref: 'main', inputs: {},
    });
  }
}

module.exports = { run, stillAuthorized, authPersistenceFailed, authFingerprint, recoverRunning };
