const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const labels = [
  ['needs-triage', 'D4C5F9', '等待维护者评估'],
  ['needs-info', 'D876E3', '等待补充需求信息'],
  ['ready-for-agent', '0E8A16', '需求已明确，可交给 Codex 实现'],
  ['ready-for-human', 'FBCA04', '需要人工实现'],
  ['wontfix', 'FFFFFF', '不予实施'],
  ['agent:implement', '0E8A16', '启动 Codex 实现，与 ready-for-agent 等价'],
  ['agent:review', '5319E7', '启动 Codex 审查 PR'],
  ['agent:update-branch', '1D76DB', '合并基准分支并解决冲突'],
  ['agent:to-issues', '5319E7', '将 PRD 拆成原生子 Issue'],
  ['agent:queued', 'FBCA04', '依赖完成后串行启动'],
  ['source:architecture-review', '5319E7', '自动架构审查提出的 PRD'],
  ['agent:in-progress', '1D76DB', 'Codex 正在执行'],
  ['agent:blocked', 'B60205', 'Codex 执行失败，需要处理后重试'],
];

async function setup({ github, context }) {
  for (const [name, color, description] of labels) {
    try {
      await github.rest.issues.getLabel({ ...context.repo, name });
    } catch (error) {
      if (error.status !== 404) throw error;
      await github.rest.issues.createLabel({ ...context.repo, name, color, description });
    }
  }
}

function issueNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Issue 编号必须是正整数。');
  }
  return Number(value);
}

function relatedPr(pr, number) {
  return pr.head.ref.startsWith(`codex/issue-${number}-`)
    || new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, 'i').test(pr.body ?? '');
}

async function removeLabel(github, args, name) {
  try { await github.rest.issues.removeLabel({ ...args, name }); }
  catch (error) { if (error.status !== 404) throw error; }
}

async function prepare({ github, context, core }) {
  core.setOutput('proceed', 'false');
  if (context.payload.repository?.private !== true) {
    throw new Error('Codex 订阅自动实现只允许在私有仓库运行。');
  }
  const number = issueNumber(context.payload.issue?.number ?? process.env.INPUT_ISSUE);
  const args = { ...context.repo, issue_number: number };
  const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
    ...context.repo, username: context.actor,
  });
  if (!['admin', 'maintain', 'write'].includes(permission.permission)) {
    throw new Error('只有拥有仓库写权限的维护者可以启动 Codex。');
  }
  const { data: issue } = await github.rest.issues.get(args);
  if (issue.pull_request) throw new Error('此工作流只接受 Issue；PR 反馈修改尚未接入。');
  if (issue.state !== 'open') {
    core.notice(`Issue #${number} 已关闭，跳过。`);
    return;
  }
  const prs = await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: 'open', per_page: 100,
  });
  const existing = prs.find((pr) => relatedPr(pr, number));
  if (existing) {
    for (const name of ['ready-for-agent', 'agent:implement']) await removeLabel(github, args, name);
    await github.rest.issues.createComment({ ...args, body: `已有开放 PR：${existing.html_url}。请在该 PR 上处理后续修改，或关闭后重新添加实现标签。` });
    core.notice('已有开放 PR，跳过重复实现。');
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, { ...args, per_page: 100 });
  await setup({ github, context });
  const contextDir = path.join(process.env.RUNNER_TEMP, 'codex-context');
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(path.join(contextDir, 'issue.json'), JSON.stringify({
    number, title: issue.title, body: issue.body ?? '', url: issue.html_url,
    comments: comments.map((comment) => ({ author: comment.user?.login ?? 'unknown', body: comment.body ?? '' })),
  }, null, 2));
  core.setOutput('issue', String(number));
  core.setOutput('base', context.payload.repository.default_branch);
  core.setOutput('sha', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  core.setOutput('branch', `codex/issue-${number}-${context.runId}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`);
  core.setOutput('proceed', 'true');
  for (const name of ['ready-for-agent', 'agent:implement', 'agent:blocked']) await removeLabel(github, args, name);
  await github.rest.issues.addLabels({ ...args, labels: ['agent:in-progress'] });
}

async function publish({ github, context, core }) {
  const number = issueNumber(process.env.ISSUE_NUMBER);
  const branch = process.env.AGENT_BRANCH;
  if (!branch?.startsWith(`codex/issue-${number}-`)) throw new Error('发布分支与 Issue 不一致。');
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  if (issue.state !== 'open') throw new Error('运行期间 Issue 已关闭，停止发布。');
  const existing = (await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: 'open', per_page: 100,
  })).find((pr) => relatedPr(pr, number));
  if (existing) throw new Error(`运行期间已创建关联 PR：${existing.html_url}，停止重复发布。`);
  const outputDir = path.join(process.env.RUNNER_TEMP, 'codex-result');
  const patchFile = path.join(outputDir, 'changes.patch');
  const summary = await fs.readFile(path.join(outputDir, 'summary.md'), 'utf8');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'inherit' });
  git('checkout', '-b', branch);
  git('apply', '--check', patchFile);
  git('apply', '--index', patchFile);
  git('-c', 'user.name=codex[bot]', '-c', 'user.email=codex[bot]@users.noreply.github.com',
    'commit', '-m', `fix: implement issue #${number}`);
  git('push', 'origin', `HEAD:refs/heads/${branch}`);
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const { data: pr } = await github.rest.pulls.create({
    ...context.repo, base: process.env.BASE_BRANCH, head: branch, draft: true,
    title: `[Codex] ${issue.title}`.slice(0, 200),
    body: `Closes #${number}\n\n由 Codex + Sandcastle 实现，需人工审查。\n\n验证已通过：\n- pnpm install --frozen-lockfile\n- pnpm check\n- pnpm demo:test\n\n### Agent 说明\n\n${summary.slice(0, 45000)}\n\n运行记录：${runUrl}`,
  });
  core.setOutput('pr_url', pr.html_url);
}

module.exports = { setup, prepare, publish, issueNumber, relatedPr };
