import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GitHub, hasLabel } from './github.js';
import { approvedPlan, parsePlan, renderPlan, sourceHash } from './plan.js';
import { publishTickets } from './publish.js';
import { Queue, hasModelRun } from './queue.js';
import { fail, required, writeJson } from '../shared/common.js';

const github = new GitHub(required('GH_REPO'));
const number = (): number => {
  const value = Number(required('ISSUE_NUMBER'));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('无效 Issue 编号。');
  return value;
};
const output = (key: string, value: string): void => {
  appendFileSync(required('GITHUB_OUTPUT'), `${key}=${value}\n`);
};
const environment = (key: string, value: string): void => {
  const delimiter = randomUUID();
  appendFileSync(required('GITHUB_ENV'), `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
};

try {
  switch (process.argv[2]) {
    case 'snapshot': {
      const issue = github.issue(number());
      if (issue.state !== 'open' || !hasLabel(issue, 'agent:to-issues')) throw new Error('来源 Issue 已关闭或拆票标签已移除。');
      if (github.parent(issue.number) !== null || github.children(issue.number).length) throw new Error('仅接受尚未发布子任务的顶层父 Issue。');
      if (['agent:implement', 'agent:in-progress', 'agent:queued'].some((label) => hasLabel(issue, label))) {
        throw new Error('请先停止已有实现或队列，再生成拆票计划。');
      }
      const comments = github.comments(issue.number);
      writeJson('source.json', { issue, comments, source_hash: sourceHash(issue, comments) });
      github.addLabels(issue.number, ['agent:in-progress']);
      try {
        github.removeLabel(issue, 'agent:to-issues');
      } catch (error) {
        github.removeLabel(github.issue(issue.number), 'agent:in-progress');
        throw error;
      }
      if (process.env.GITHUB_OUTPUT) output('started', 'true');
      break;
    }
    case 'record': {
      const plan = parsePlan(JSON.parse(readFileSync(required('PLAN_FILE'), 'utf8')));
      const snapshot = JSON.parse(readFileSync(required('SOURCE_FILE'), 'utf8')) as { issue: { number: number }; source_hash: string };
      const issue = github.issue(number());
      if (plan.parent !== issue.number || snapshot.issue.number !== issue.number || plan.source_hash !== snapshot.source_hash
        || sourceHash(issue, github.comments(issue.number)) !== snapshot.source_hash) throw new Error('拆票期间需求发生变化或输出来源不匹配，请重新拆票。');
      if (issue.state !== 'open' || !hasLabel(issue, 'agent:in-progress') || github.children(issue.number).length) throw new Error('来源状态已变化，拒绝保存计划。');
      github.comment(issue.number, renderPlan(plan));
      break;
    }
    case 'finish-plan': {
      github.removeLabel(github.issue(number()), 'agent:in-progress');
      break;
    }
    case 'publish': {
      const plan = approvedPlan(github.comments(number()), required('APPROVED_AT'));
      if (plan.parent !== number()) throw new Error('计划不属于当前父 Issue。');
      publishTickets(github, plan);
      break;
    }
    case 'prepare': {
      const result = new Queue(github).prepare(number());
      output('proceed', String(result.issue !== undefined));
      if (result.issue) {
        environment('ISSUE_NUMBER', String(result.issue.number));
        environment('ISSUE_TITLE', result.issue.title);
        environment('PARENT_NUMBER', result.parent === undefined ? '' : String(result.parent));
      }
      break;
    }
    case 'verify': {
      new Queue(github).verify(number());
      break;
    }
    case 'promote': {
      if (hasModelRun(github)) {
        console.log('模型工作流仍在运行或排队，保留 queued 任务等待下一次扫描。');
        break;
      }
      const selected = new Queue(github, process.env.AGENT_PAT ? new GitHub(github.repo, process.env.AGENT_PAT) : undefined).promote();
      console.log(selected ? `已转交 #${selected} 的 agent:implement。` : '暂无可执行任务。');
      break;
    }
    case 'review': {
      const pr = Number(required('PR_NUMBER'));
      if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('无效 PR 编号。');
      if (process.env.AGENT_PAT) {
        new GitHub(github.repo, process.env.AGENT_PAT).addLabels(pr, ['agent:review']);
      } else {
        github.addLabels(pr, ['agent:review']);
        // GITHUB_TOKEN 推送/贴标不会接续；官方允许 workflow_dispatch 例外。
        github.api('POST', 'actions/workflows/check.yml/dispatches', { ref: required('BRANCH') });
        github.api('POST', 'actions/workflows/agent-review.yml/dispatches', {
          ref: 'main', inputs: { pr_number: String(pr) },
        });
      }
      break;
    }
    default: throw new Error('未知 tickets 控制命令。');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
