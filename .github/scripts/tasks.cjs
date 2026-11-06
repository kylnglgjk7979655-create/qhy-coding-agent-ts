const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { issueNumber, relatedPr, setup } = require('./agent.cjs');
const { MODES, MUTATING, validateResult, reviewPayload } = require('./task-protocol.cjs');
const { labelNames, isHumanTask, isCompleted, isAgentOpen, selectReadyChild, parentReference } = require('./ticket-policy.cjs');
const PR_MODES = ['review', 'implement-pr', 'update-branch'];
const TRIGGERS = { implement: ['agent:implement'], 'implement-prd': ['agent:implement'], review: ['agent:review'], 'implement-pr': ['agent:implement'], 'update-branch': ['agent:update-branch'], 'to-issues': ['agent:to-issues'], architecture: [] };
const temp = (...parts) => path.join(process.env.RUNNER_TEMP, ...parts);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'codex[bot]', GIT_AUTHOR_EMAIL: 'codex[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'codex[bot]', GIT_COMMITTER_EMAIL: 'codex[bot]@users.noreply.github.com' },
}).trim();
async function removeLabel(github, args, name) {
  try { await github.rest.issues.removeLabel({ ...args, name }); }
  catch (error) { if (error.status !== 404) throw error; }
}
async function authorize(github, context) {
  if (context.payload.repository?.private !== true) throw new Error('Codex 订阅任务只允许在私有仓库运行。');
  // 只有可信 workflow 持有的 GITHUB_TOKEN 能以该机器人身份发起 dispatch。
  if (context.eventName === 'workflow_dispatch' && context.actor === 'github-actions[bot]') return;
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: context.actor });
  if (!['admin', 'maintain', 'write'].includes(data.permission)) throw new Error('只有拥有写权限的维护者可以启动任务。');
}
async function subIssues(github, repo, number) {
  return github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...repo, issue_number: number, per_page: 100 });
}
async function issueShape(github, repo, number) {
  const result = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{number}}}}`, { ...repo, number });
  return result.repository.issue;
}
async function blockers(github, repo, number) {
  let after = null;
  const nodes = [];
  do {
    const result = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){issue(number:$number){blockedBy(first:100,after:$after){nodes{number state stateReason} pageInfo{hasNextPage endCursor}}}}}`, { ...repo, number, after });
    const connection = result.repository.issue.blockedBy;
    nodes.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}
function canPromote(issue, parent, dependencies) {
  const labels = labelNames(issue);
  return issue.state === 'open' && !isHumanTask(issue) && !parent && labels.includes('agent:queued')
    && !labels.includes('agent:in-progress') && !labels.includes('agent:blocked')
    && dependencies.every(isCompleted);
}
async function issueContext(github, repo, number) {
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: number });
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  return { number, title: issue.title, body: issue.body ?? '', url: issue.html_url, state: issue.state, labels: issue.labels ?? [],
    comments: comments.map((c) => ({ id: c.id, author: c.user?.login, body: c.body })) };
}
async function prFeedback(github, repo, number) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: number, per_page: 100 });
  const threads = [];
  let after = null;
  do {
    const result = await github.graphql(`query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved path line comments(first:100){nodes{databaseId body author{login}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}`, { ...repo, number, after });
    const connection = result.repository.pullRequest.reviewThreads;
    for (const thread of connection.nodes.filter((t) => !t.isResolved)) {
      if (thread.comments.pageInfo.hasNextPage) throw new Error('单个 review thread 超过 100 条评论，请先人工整理再重试。');
      threads.push({ id: thread.id, path: thread.path, line: thread.line, comments: thread.comments.nodes.map((c) => ({ id: c.databaseId, body: c.body, author: c.author?.login })) });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return { comments: comments.map((c) => ({ id: c.id, author: c.user?.login, body: c.body })),
    reviews: reviews.map((r) => ({ id: r.id, state: r.state, body: r.body, author: r.user?.login })), threads };
}
function assertPr(pr, repo) {
  if (pr.state !== 'open' || pr.merged) throw new Error('PR 已关闭或合并。');
  if (pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}` || pr.base.repo?.full_name !== `${repo.owner}/${repo.repo}`) throw new Error('只允许本仓库分支上的 PR，拒绝 fork。');
  if (pr.head.ref === pr.base.ref) throw new Error('不能把 PR 修改发布到基准分支。');
}
async function refSha(github, repo, branch) {
  const { data } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
  return data.object.sha;
}
async function prepare({ github, context, core }) {
  core.setOutput('proceed', 'false');
  await authorize(github, context);
  let mode = process.env.TASK_MODE;
  if (!MODES.includes(mode)) throw new Error('未知任务类型。');
  const number = mode === 'architecture' ? 0 : issueNumber(process.env.TASK_NUMBER);
  const task = { mode, number, repo: context.repo, base: context.payload.repository.default_branch };
  task.baseSha = await refSha(github, context.repo, task.base);
  task.sha = task.baseSha;
  task.branch = `codex/issue-${number}-${context.runId}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const subject = number;
  if (PR_MODES.includes(mode)) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    assertPr(pr, context.repo);
    Object.assign(task, { pr: { number, title: pr.title, body: pr.body, url: pr.html_url, nodeId: pr.node_id }, base: pr.base.ref, baseSha: pr.base.sha, sha: pr.head.sha, branch: pr.head.ref });
    task.feedback = await prFeedback(github, context.repo, number);
    if (mode === 'implement-pr' && !task.feedback.comments.length && !task.feedback.threads.length && !task.feedback.reviews.some((r) => r.body?.trim())) {
      throw new Error('PR 没有可处理的反馈。');
    }
    const linked = new Set([...String(pr.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of)\s+#([1-9]\d*)\b/gi)].map((match) => Number(match[1])));
    task.linkedIssues = [];
    for (const n of linked) {
      const issue = await issueContext(github, context.repo, n);
      issue.children = await subIssues(github, context.repo, n);
      task.linkedIssues.push(issue);
    }
  } else if (mode === 'architecture') {
    task.proposals = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, labels: 'source:architecture-review', state: 'all', per_page: 100 });
    if (task.proposals.filter((issue) => issue.state === 'open').length >= 10) { core.notice('已有10个开放架构提案，跳过本轮。'); return; }
  } else {
    task.issue = await issueContext(github, context.repo, number);
    if (isHumanTask(task.issue)) throw new Error('人工 QA 任务不能交给自动实现。');
    if (task.issue.state !== 'open') { core.notice('Issue 已关闭，跳过。'); return; }
    const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
    if (issue.pull_request) throw new Error('Issue 入口不接受 PR。');
    const shape = await issueShape(github, context.repo, number);
    if (shape.parent) throw new Error('请给父 PRD 添加标签，不要直接运行子 Issue。');
    const dependencies = await blockers(github, context.repo, number);
    if (!dependencies.every(isCompleted)) throw new Error('依赖尚未完成，请先处理依赖并使用 agent:queued 排队。');
    task.children = await subIssues(github, context.repo, number);
    if (mode === 'to-issues') {
      // 部分发布失败后的重试由发布端的稳定 marker 恢复，不重复创建。
      if (task.children.some((child) => !(child.body ?? '').includes(`<!-- codex-prd:${number}:slice:`))) throw new Error('PRD 已有非本工作流创建的子 Issue，拒绝重复拆分。');
    } else {
      if (task.children.length) mode = 'implement-prd';
      if (mode === 'implement-prd') {
        if (!task.children.length) throw new Error('PRD 没有子 Issue，请先添加 agent:to-issues。');
        for (const child of task.children) {
          if ((await subIssues(github, context.repo, child.number)).length) throw new Error('不支持嵌套子 Issue，请先展平 PRD。');
        }
        const dependencies = new Map(await Promise.all(task.children.filter(isAgentOpen).map(async (child) => [child.number, await blockers(github, context.repo, child.number)])));
        task.child = selectReadyChild(task.children, dependencies);
        if (!task.child) {
          if (task.children.some(isAgentOpen)) throw new Error('开放实现任务仍有阻塞依赖，停止推进。');
          core.notice('实现子任务已完成；人工 QA 保持开放，等待人验收。'); return;
        }
        task.branch = `codex/prd-${number}`;
        try { task.sha = await refSha(github, context.repo, task.branch); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      const prs = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', per_page: 100 });
      const existing = prs.find((pr) => relatedPr(pr, number) || pr.head.ref === task.branch);
      if (existing && (mode !== 'implement-prd' || existing.head.ref !== task.branch)) {
        for (const label of TRIGGERS[mode]) await removeLabel(github, { ...context.repo, issue_number: number }, label);
        core.notice(`已有开放 PR：${existing.html_url}`);
        return;
      }
      if (existing) { assertPr(existing, context.repo); task.existingPr = existing.number; }
      if (mode === 'implement-prd' && !existing && task.sha !== task.baseSha) {
        const history = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'closed', head: `${context.repo.owner}:${task.branch}`, per_page: 100 });
        if (history.length) throw new Error('PRD 旧 PR 已关闭，请先恢复或人工整理分支。');
      }
    }
  }
  task.mode = mode;
  task.subject = subject;
  await setup({ github, context });
  await fs.mkdir(temp('codex-context'), { recursive: true });
  await fs.writeFile(temp('codex-context/task.json'), JSON.stringify(task, null, 2));
  for (const [key, value] of Object.entries({ mode, subject, sha: task.sha, base_sha: task.baseSha, branch: task.branch, base: task.base })) core.setOutput(key, String(value));
  // 输出 subject 早于后续动作，prepare 或认证预检失败也能清理状态。
  if (subject) {
    const args = { ...context.repo, issue_number: subject };
    for (const label of [...TRIGGERS[mode], 'agent:blocked', 'agent:queued']) await removeLabel(github, args, label);
    await github.rest.issues.addLabels({ ...args, labels: ['agent:in-progress'] });
  }
  core.setOutput('proceed', 'true');
}
async function readTask() { return JSON.parse(await fs.readFile(temp('codex-context/task.json'), 'utf8')); }
async function dispatch(github, context, workflow_id, inputs = {}, ref = context.payload.repository.default_branch) {
  await github.rest.actions.createWorkflowDispatch({ ...context.repo, workflow_id, ref, inputs });
}
async function exportPatch() {
  const task = await readTask();
  const work = process.env.AGENT_WORKSPACE;
  const base = git(work, 'rev-parse', 'HEAD');
  if (base !== task.sha) throw new Error('Agent 改写了 HEAD，拒绝导出。');
  if (git(work, 'diff', '--name-only', '--diff-filter=U')) throw new Error('仍有未解决的合并冲突。');
  const result = validateResult(task.mode, JSON.parse(await fs.readFile(temp('codex-result/result.json'), 'utf8')));
  git(work, 'add', '--all');
  git(work, 'diff', '--cached', '--check');
  const patch = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--cached', '--binary', '--full-index', task.sha], { cwd: work, maxBuffer: 50 * 1024 * 1024 });
  if (!MUTATING.includes(task.mode) && patch.length) throw new Error('只读任务修改了工作区，拒绝发布。');
  if (task.mode === 'implement' && !patch.length) throw new Error('没有产生修改，请检查 Issue 需求。');
  await fs.writeFile(temp('codex-result/changes.patch'), patch);
  await fs.writeFile(temp('codex-result/result.json'), JSON.stringify(result));
}
const PLAN_MARKER = '<!-- codex-prd-plan -->';
function parsePlan(comment) {
  if (comment.user?.login !== 'github-actions[bot]' || !comment.body?.startsWith(PLAN_MARKER)) return undefined;
  const raw = comment.body.slice(PLAN_MARKER.length).trim();
  const json = raw.startsWith('```json') ? raw.match(/^```json\n([\s\S]*?)\n```/)?.[1] : raw;
  return validateResult('to-issues', JSON.parse(json));
}
async function savedPlan(github, repo, number) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  return [...comments].reverse().find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(PLAN_MARKER));
}
async function saveDraftPlan(github, context, task, result) {
  const current = await subIssues(github, context.repo, task.number);
  if (current.length) throw new Error('已有子任务，请使用已保存的计划恢复发布，不要重新规划。');
  const all = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'all', per_page: 100 });
  if (all.some((issue) => issue.body?.includes(`<!-- codex-prd:${task.number}:slice:`))) throw new Error('已有发布中的计划，请继续 agent:publish-tickets，不要重新规划。');
  await github.rest.issues.createComment({ ...context.repo, issue_number: task.number,
    body: `${PLAN_MARKER}\n\x60\x60\x60json\n${JSON.stringify(result, null, 2)}\n\x60\x60\x60\n\n拆票计划待审批。请检查切片和依赖；确认后添加 agent:publish-tickets，再给父需求添加 agent:implement 才开始实现。` });
}
async function publishSlices(github, context, task, proposedResult) {
  const args = { ...context.repo, issue_number: task.number };
  const current = await subIssues(github, context.repo, task.number);
  if (current.some((child) => !(child.body ?? '').includes(`<!-- codex-prd:${task.number}:slice:`))) throw new Error('发布期间新增了其他子 Issue，停止拆分。');
  const comment = await savedPlan(github, context.repo, task.number);
  const result = comment ? parsePlan(comment) : validateResult('to-issues', proposedResult);
  if (!comment) throw new Error('缺少已保存的计划，请先生成并审批。');
  const all = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'all', per_page: 100 });
  const created = [];
  for (let i = 0; i < result.slices.length; i++) {
    const slice = result.slices[i];
    const marker = `<!-- codex-prd:${task.number}:slice:${i + 1} -->`;
    const human = slice.execution === 'human-qa';
    const body = `${marker}\n\n**Execution:** ${human ? 'Human QA (HITL)' : 'Agent'}\n\n${slice.whatToBuild}\n\n## 验收条件\n\n${slice.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}\n\nPart of #${task.number}`;
    let issue = all.find((candidate) => !candidate.pull_request && candidate.body?.includes(marker));
    if (!issue) {
      ({ data: issue } = await github.rest.issues.create({ ...context.repo, title: slice.title, body, labels: [human ? 'ready-for-human' : 'ready-for-agent'] }));
      all.push(issue);
    }
    if (!current.some((child) => child.id === issue.id)) await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...args, sub_issue_id: issue.id });
    created.push(issue);
  }
  for (let i = 0; i < created.length; i++) {
    const issue = created[i];
    const existing = await github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', { ...context.repo, issue_number: issue.number, per_page: 100 });
    for (const position of result.slices[i].blockedBy) {
      const blocker = created[position - 1];
      if (!existing.some((dep) => dep.id === blocker.id)) await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', { ...context.repo, issue_number: issue.number, issue_id: blocker.id });
    }
  }
  await github.rest.issues.createComment({ ...args, body: `已发布 ${result.slices.length} 个原生子 Issue 和阻塞关系。请给父需求添加 agent:implement 开始；人工任务不会由 Agent 执行或关闭。\n\n${result.summary}` });
}
async function publishApprovedSlices({ github, context, core }) {
  await authorize(github, context);
  const number = issueNumber(process.env.TASK_NUMBER);
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  if (issue.state !== 'open' || issue.pull_request || isHumanTask(issue) || (await issueShape(github, context.repo, number)).parent) throw new Error('只允许为开放的父规格发布子任务。');
  const comment = await savedPlan(github, context.repo, number);
  if (!comment) throw new Error('请先添加 agent:to-issues 生成计划。');
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: context.runId });
  const planTime = Date.parse(comment.updated_at ?? comment.created_at);
  const approvalTime = Date.parse(run.created_at);
  if (!Number.isFinite(planTime) || !Number.isFinite(approvalTime) || planTime > approvalTime) throw new Error('计划生成于审批触发之后，请检查后重新确认。');
  await setup({ github, context });
  await publishSlices(github, context, { number }, parsePlan(comment));
  await removeLabel(github, { ...context.repo, issue_number: number }, 'agent:publish-tickets');
  core.notice('已按批准计划发布子任务及依赖关系。');
}
function prBody(task, result, children = []) {
  const content = result.prBody ?? `## Summary\n\n${result.summary}\n\n## Evidence\n\n- pnpm check\n- pnpm demo:test\n\n## Merge Danger\n\n**Door:** two-way\n\n**Blast Radius:** 本 Issue 涉及的模块；请人工检查差异和验收结果。`;
  const safeContent = content.replace(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?=(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/)/gi, 'Refs ');
  return `${parentReference(task.number, children)}\n\n${safeContent}\n\n${children.map((child) => `- [${child.state === 'closed' || child.number === task.child?.number ? 'x' : ' '}] #${child.number}${isHumanTask(child) ? '（人工 QA）' : ''}`).join('\n')}`;
}
async function publish({ github, context, core, cwd = process.cwd() }) {
  const task = await readTask();
  const result = validateResult(task.mode, JSON.parse(await fs.readFile(temp('codex-result/result.json'), 'utf8')));
  if (task.mode === 'to-issues') {
    const { data: current } = await github.rest.issues.get({ ...context.repo, issue_number: task.number });
    if (current.state !== 'open') throw new Error('PRD 在运行期间已关闭。');
    await saveDraftPlan(github, context, task, result);
    return;
  }
  if (task.mode === 'architecture') {
    if (result.status === 'proposed') {
      const proposals = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, labels: 'source:architecture-review', state: 'all', per_page: 100 });
      if (!proposals.some((p) => p.title.trim() === result.title.trim())) {
        const { data: issue } = await github.rest.issues.create({ ...context.repo, title: result.title, body: `${result.body}\n\n${result.summary}`, labels: ['source:architecture-review'] });
        core.setOutput('url', issue.html_url);
      }
    }
    return;
  }
  let pr;
  if (PR_MODES.includes(task.mode)) {
    ({ data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: task.number }));
    assertPr(pr, context.repo);
    if (pr.head.sha !== task.sha || pr.head.ref !== task.branch || pr.base.ref !== task.base) throw new Error('PR 分支或基准已变化，请重新运行。');
  } else {
    const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: task.number });
    if (issue.state !== 'open') throw new Error('运行期间 Issue 已关闭。');
    const prs = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', per_page: 100 });
    const matches = prs.filter((p) => relatedPr(p, task.number) || p.head.ref === task.branch);
    pr = matches.find((p) => p.head.ref === task.branch);
    if (matches.some((p) => p.head.ref !== task.branch)) throw new Error('运行期间出现其他关联 PR，停止重复发布。');
    if (task.existingPr && (!pr || pr.number !== task.existingPr)) throw new Error('PRD 的 PR 已关闭或变化。');
    if (pr) assertPr(pr, context.repo);
    if (pr && pr.head.sha !== task.sha) throw new Error('PRD 分支已有新提交，请重试。');
  }
  if (task.mode === 'implement-prd') {
    const children = await subIssues(github, context.repo, task.number);
    const current = children.find((child) => child.number === task.child.number);
    if (!current || !isAgentOpen(current)) throw new Error('本轮子任务已移除、关闭或改为人工任务，停止发布。');
    if (!(await blockers(github, context.repo, current.number)).every(isCompleted)) throw new Error('子任务依赖发生变化，停止发布。');
  }
  const patchFile = temp('codex-result/changes.patch');
  const patch = await fs.readFile(patchFile, 'utf8');
  if (task.mode === 'implement' && !patch) throw new Error('单 Issue 实现不允许空补丁。');
  const allowedReplies = new Set((task.feedback?.threads ?? []).flatMap((thread) => thread.comments.map((comment) => comment.id)));
  if ((result.replies ?? []).some((reply) => !allowedReplies.has(reply.commentId))) throw new Error('回复指向未提供的 PR thread。');
  git(cwd, 'checkout', '--detach', task.sha);
  let commit = task.sha;
  if (patch) {
    git(cwd, 'apply', '--check', patchFile);
    git(cwd, 'apply', '--index', patchFile);
  }
  const parents = ['-p', task.sha];
  if (task.mode === 'update-branch') {
    if (await refSha(github, context.repo, task.base) !== task.baseSha) throw new Error('基准分支已前进，请重新更新。');
    // 即使文件内容相同，也可能需要记录 base 为 merge parent。
    try { git(cwd, 'merge-base', '--is-ancestor', task.baseSha, task.sha); }
    catch { parents.push('-p', task.baseSha); }
  }
  if (patch || parents.length > 2) {
    const tree = git(cwd, 'write-tree');
    commit = git(cwd, 'commit-tree', tree, ...parents, '-m', `chore: Codex ${task.mode} #${task.number}`);
    // 不 force；远端分支前进时自然拒绝推送。
    git(cwd, 'push', 'origin', `${commit}:refs/heads/${task.branch}`);
    core.setOutput('changed', 'true');
  }
  if (!pr) {
    const children = task.children ?? [];
    ({ data: pr } = await github.rest.pulls.create({ ...context.repo, base: task.base, head: task.branch, draft: true,
      title: result.prTitle ?? `[Codex] ${task.issue.title}`.slice(0, 200),
      body: prBody(task, result, children) }));
  }
  core.setOutput('url', pr.html_url);
  core.setOutput('pr_number', String(pr.number));
  core.setOutput('branch', task.branch);
  if (task.mode === 'review') {
    const patchToBase = git(cwd, 'diff', '--no-ext-diff', `${task.baseSha}...${commit}`);
    await github.rest.pulls.createReview({ ...context.repo, pull_number: pr.number, ...reviewPayload(result, patchToBase, commit) });
    // 审查发布 COMMENT，不自动 APPROVE 或 merge。
    if (pr.draft) await github.graphql('mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}', { id: pr.node_id });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body: result.summary });
  }
  for (const reply of result.replies ?? []) {
    if (!allowedReplies.has(reply.commentId)) throw new Error('回复指向未提供的 PR thread。');
    await github.rest.pulls.createReplyForReviewComment({ ...context.repo, pull_number: pr.number, comment_id: reply.commentId, body: reply.body });
  }
  if (task.mode === 'implement-prd') {
    const children = await subIssues(github, context.repo, task.number);
    if (!children.some((child) => child.number === task.child.number && isAgentOpen(child))) throw new Error('子任务已从 PRD 移除，停止推进。');
    await github.rest.issues.createComment({ ...context.repo, issue_number: task.child.number, body: `已在 ${commit} 完成并通过验证；属于 PRD #${task.number}，等待 ${pr.html_url} 合并。\n\n${result.summary}` });
    await github.rest.issues.update({ ...context.repo, issue_number: task.child.number, state: 'closed', state_reason: 'completed' });
    const remaining = children.filter((child) => isAgentOpen(child) && child.number !== task.child.number);
    await github.rest.pulls.update({ ...context.repo, pull_number: pr.number, body: prBody(task, result, children) });
    core.setOutput('next', remaining.length ? 'implement-prd' : 'review');
  } else if (task.mode === 'implement') core.setOutput('next', 'review');
}
async function finish({ github, context, core }) {
  const subject = Number(process.env.TASK_SUBJECT || 0);
  const ok = process.env.PUBLISH_RESULT === 'success';
  const url = process.env.RESULT_URL || '';
  const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  let next = process.env.NEXT_TASK;
  let handoffFailed = false;
  try {
    if (ok && process.env.CODE_CHANGED === 'true' && process.env.RESULT_BRANCH) {
      await dispatch(github, context, 'check.yml', {}, process.env.RESULT_BRANCH);
    }
    if (ok && next) {
      if (next === 'review') await dispatch(github, context, 'agent-review.yml', { pr_number: process.env.RESULT_PR });
      else await dispatch(github, context, 'agent-implement-prd.yml', { issue_number: String(subject) });
    }
  } catch (error) {
    next = undefined;
    handoffFailed = true;
    core.setFailed(`当前任务已发布，但自动接续失败：${error.message}`);
    if (subject) await github.rest.issues.createComment({ ...context.repo, issue_number: subject, body: `当前结果已发布，但接续任务未启动，请手动触发。\n\n${run}` });
  } finally {
    if (subject) {
      const args = { ...context.repo, issue_number: subject };
      if (!ok) await github.rest.issues.addLabels({ ...args, labels: ['agent:blocked'] });
      await removeLabel(github, args, 'agent:in-progress');
      await github.rest.issues.createComment({ ...args, body: ok
        ? `Codex 任务完成。${url}\n\n${next ? `已启动后续任务：${next}。` : '请人工检查结果。'}\n\n运行记录：${run}`
        : `Codex 任务失败，已停止自动推进。生成：${process.env.GENERATE_RESULT}；登录态保存：${process.env.AUTH_RESULT}；发布：${process.env.PUBLISH_RESULT}。\n\n运行记录：${run}\n\n处理后重新添加对应标签，或在 Actions 手动触发新的运行。` });
    }
  }
  if (ok && !next && !handoffFailed) await dispatch(github, context, 'agent-promote-queued.yml');
}
async function promote({ github, context, core }) {
  await authorize(github, context);
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, labels: 'agent:queued', state: 'open', sort: 'created', direction: 'asc', per_page: 100 });
  for (const candidate of issues.filter((issue) => !issue.pull_request)) {
    const shape = await issueShape(github, context.repo, candidate.number);
    const dependencies = await blockers(github, context.repo, candidate.number);
    const { data: fresh } = await github.rest.issues.get({ ...context.repo, issue_number: candidate.number });
    if (!canPromote(fresh, shape.parent, dependencies)) continue;
    // 每次只派发一个，避免 GitHub concurrency 的单 pending 槽覆盖其他任务。
    // 标签交给接收端 prepare 消费；dispatch 失败仍保留 queued 可重试。
    await dispatch(github, context, 'agent-implement.yml', { issue_number: String(candidate.number) });
    core.notice(`已派发排队任务 #${candidate.number}。其余在本轮结束后继续。`);
    break;
  }
}
module.exports = { authorize, prepare, publish, finish, promote, exportPatch, canPromote, assertPr, prFeedback, publishSlices, publishApprovedSlices, saveDraftPlan, parsePlan, prBody };
if (require.main === module) {
  if (process.argv[2] !== 'export') throw new Error('只支持 export。');
  exportPatch().catch((error) => { console.error(error); process.exitCode = 1; });
}
