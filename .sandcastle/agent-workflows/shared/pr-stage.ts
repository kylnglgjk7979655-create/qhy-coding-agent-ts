import { execFileSync } from 'node:child_process';
import { GitHub } from '../tickets/github.js';

/** 内部接续统一写队列，避免 PAT 标签事件丢失实现来源或重复分发。 */
export function requestPrStage(github: GitHub, pr: number, stage: 'review' | 'qa', branch: string): void {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('无效 PR 编号。');
  const pull = github.api<{
    state: string; head: { sha: string; ref: string; repo: { full_name: string } | null };
  }>('GET', `pulls/${pr}`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (pull.state !== 'open' || pull.head.repo?.full_name !== github.repo
    || pull.head.ref !== branch || pull.head.sha !== head) {
    throw new Error('PR 已关闭、来自 fork 或远程版本与已发布提交不一致，停止接续。');
  }
  github.addLabels(pr, [`agent:${stage}`]);
  if (stage === 'review' && !process.env.AGENT_PAT) {
    github.api('POST', 'actions/workflows/check.yml/dispatches', { ref: branch });
  }
  github.queueTask({
    id: `internal-${stage}-${pr}-${head}-${process.env.GITHUB_RUN_ID || Date.now()}`,
    kind: stage, number: pr, workflow: `agent-${stage}.yml`,
    inputs: {
      pr_number: String(pr), authorization_label: `agent:${stage}`, expected_head_sha: head,
      ...(stage === 'review' ? { qa_after_review: 'true' } : {}),
    },
  });
}
