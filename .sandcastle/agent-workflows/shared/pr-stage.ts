import { execFileSync } from 'node:child_process';
import { GitHub } from '../tickets/github.js';

/**
 * 内部接续通过 AGENT_PAT 重新贴标签。
 * GITHUB_TOKEN 贴出的标签不会触发下游 workflow，因此这里不再写持久队列。
 */
export function requestPrStage(github: GitHub, pr: number, branch: string): void {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('无效 PR 编号。');
  const pull = github.api<{
    state: string; head: { sha: string; ref: string; repo: { full_name: string } | null };
  }>('GET', `pulls/${pr}`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (pull.state !== 'open' || pull.head.repo?.full_name !== github.repo
    || pull.head.ref !== branch || pull.head.sha !== head) {
    throw new Error('PR 已关闭、来自 fork 或远程版本与已发布提交不一致，停止接续。');
  }
  const pat = process.env.AGENT_PAT;
  if (!pat) throw new Error('内部接续需要 AGENT_PAT。');
  new GitHub(github.repo, pat).addLabels(pr, ['agent:review']);
}
