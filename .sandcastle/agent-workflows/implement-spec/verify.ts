import { execFileSync } from 'node:child_process';
import { GitHub, hasLabel } from '../tickets/github.js';
import { fail, required } from '../shared/common.js';

try {
  const number = Number(required('ISSUE_NUMBER'));
  const branch = required('BRANCH');
  const github = new GitHub(required('GH_REPO'));
  const parent = github.issue(number);
  const children = github.children(number);
  if (parent.state !== 'open' || !hasLabel(parent, 'agent:implement-spec') || !children.length) {
    throw new Error('父需求状态或授权已改变，拒绝发布。');
  }
  const prs = JSON.parse(execFileSync('gh', [
    'pr', 'list', '--state', 'open', '--head', branch, '--base', 'main',
    '--json', 'number,body,isDraft,headRefOid',
  ], { encoding: 'utf8' })) as Array<{ number: number; body: string; isDraft: boolean; headRefOid: string }>;
  if (prs.length !== 1 || !prs[0]?.isDraft) throw new Error('没有唯一的集成草稿 PR。');
  const pr = prs[0];
  for (const issue of [parent, ...children]) {
    if (!new RegExp(`\\b(?:closes|fixes|resolves)\\s+#${issue.number}\\b`, 'iu').test(pr.body)) {
      throw new Error(`PR 缺少关闭 #${issue.number} 的引用。`);
    }
  }
  const head = execFileSync('git', ['rev-parse', branch], { encoding: 'utf8' }).trim();
  if (head !== pr.headRefOid) throw new Error('PR 分支与本地集成分支不一致。');
  execFileSync('gh', ['pr', 'ready', String(pr.number)], { stdio: 'inherit' });
  github.removeLabel(parent, 'agent:implement-spec');
  if (process.env.HAS_AGENT_PAT !== 'true') {
    github.api('POST', 'actions/workflows/check.yml/dispatches', { ref: branch });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
