import * as path from 'node:path';
import { run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { codexAgent, fail, required } from '../shared/common.js';
import { GitHub, hasLabel } from '../tickets/github.js';
import { assertAcyclic } from './dependencies.js';

try {
  const raw = required('ISSUE_NUMBER');
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('无效父 Issue 编号。');
  const github = new GitHub(required('GH_REPO'));
  const parent = github.issue(number);
  const children = github.children(number);
  if (parent.state !== 'open' || !hasLabel(parent, 'agent:implement-spec')) throw new Error('父 Issue 已关闭或授权标签已移除。');
  if (github.parent(number) !== null || children.length === 0) throw new Error('需要已有子任务的顶层父 Issue；此流程不拆票。');
  if (['agent:implement', 'agent:queued', 'agent:in-progress', 'agent:blocked'].some((label) => hasLabel(parent, label))) {
    throw new Error('父 Issue 存在其他执行或暂停标签，请先处理。');
  }
  if (children.some((child) => child.state !== 'open')) throw new Error('子任务必须全部开放；已有进度需人工核查后处理。');
  const childIds = new Set(children.map((child) => child.id));
  const dependencies = new Map<number, number[]>();
  for (const blocker of github.blockers(number)) {
    if (blocker.state !== 'closed' || blocker.state_reason !== 'completed') throw new Error(`父需求的前置 #${blocker.number} 尚未完成。`);
  }
  for (const child of children) {
    if (['agent:implement', 'agent:queued', 'agent:in-progress', 'agent:blocked'].some((label) => hasLabel(child, label))) {
      throw new Error(`子任务 #${child.number} 存在其他执行或暂停标签。`);
    }
    if (github.children(child.number).length) throw new Error('不支持嵌套子任务。');
    const internal: number[] = [];
    for (const blocker of github.blockers(child.number)) {
      if (childIds.has(blocker.id)) internal.push(blocker.id);
      if (!childIds.has(blocker.id) && (blocker.state !== 'closed' || blocker.state_reason !== 'completed')) {
        throw new Error(`子任务 #${child.number} 的外部前置 #${blocker.number} 尚未完成。`);
      }
    }
    dependencies.set(child.id, internal);
  }
  assertAcyclic(dependencies);
  await run({
    name: `implement-spec-#${number}`,
    agent: codexAgent(), sandbox: noSandbox(), logging: { type: 'stdout' },
    promptFile: path.join(import.meta.dirname, 'prompt.md'),
    promptArgs: { ISSUE_NUMBER: raw, BRANCH: required('BRANCH') },
    completionSignal: '<promise>COMPLETE</promise>',
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
