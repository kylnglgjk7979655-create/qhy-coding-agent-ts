import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { isHumanTask, selectReadyChild, parentReference } = require('../.github/scripts/ticket-policy.cjs');
const { validateResult } = require('../.github/scripts/task-protocol.cjs');
const { canPromote, prBody } = require('../.github/scripts/tasks.cjs');

describe('人工 QA 及依赖图', () => {
  it.each([{ labels: ['ready-for-human'] }, { labels: [{ name: 'ready-for-human' }] }, { body: '**Execution:** Human QA (HITL)' }, { body: '**Status:** ready-for-human' }, { title: 'QA: 验收' }])('识别人工角色，即使误加执行或排队标签也不领取', (issue) => {
    expect(isHumanTask(issue)).toBe(true);
    expect(canPromote({ ...issue, state: 'open', labels: [...(issue.labels ?? []), 'agent:queued'] }, null, [])).toBe(false);
    expect(selectReadyChild([{ ...issue, number: 1, state: 'open' }], new Map())).toBeUndefined();
  });
  it('按真实依赖选票，不能因列表在前就越过依赖', () => {
    const children = [{ number: 2, state: 'open' }, { number: 1, state: 'open' }, { number: 3, state: 'open', title: 'QA: 验收' }];
    const dependencies = new Map([[2, [{ state: 'OPEN' }]], [1, []]]);
    expect(selectReadyChild(children, dependencies).number).toBe(1);
    dependencies.set(2, [{ state: 'CLOSED' }]); expect(selectReadyChild(children, dependencies).number).toBe(2);
  });
  it('有人验收的父单只关联，不因合并提前关闭；普通 Issue 保持自动关闭', () => {
    expect(parentReference(42, [{ labels: ['ready-for-human'] }])).toBe('Refs #42');
    expect(parentReference(42, [])).toBe('Closes #42');
  });
  it('接受纯实现计划及已有人工 QA 计划，拒绝无效依赖', () => {
    const a = { title: '第一片', execution: 'agent', blockedBy: [], whatToBuild: '行为', acceptanceCriteria: ['验收'] };
    const b = { ...a, title: '第二片', blockedBy: [1] };
    const qa = { ...a, title: 'QA: 验收', execution: 'human-qa', blockedBy: [1, 2] };
    expect(validateResult('to-issues', { summary: '计划', slices: [a, b, qa] }).slices).toHaveLength(3);
    expect(validateResult('to-issues', { summary: '计划', slices: [a] }).slices).toHaveLength(1);
    expect(validateResult('to-issues', { summary: '计划', slices: [a, b] }).slices).toHaveLength(2);
    for (const slices of [[a, b, { ...qa, blockedBy: [1] }], [{ ...a, blockedBy: [2] }, b, qa], [a, { ...b, blockedBy: [1, 1] }, qa], [qa], [a, qa, b]]) {
      expect(() => validateResult('to-issues', { summary: '计划', slices })).toThrow();
    }
  });
});


it('Agent 摘要中的关闭指令不会绕过人工 QA 的父单保护', () => {
  const body = prBody({ number: 42 }, { summary: 'Fixes #42，Closes owner/repo#99，Resolves https://github.com/owner/repo/issues/12' }, [{ labels: ['ready-for-human'], number: 51, state: 'open' }]);
  expect(body).toContain('Refs #42'); expect(body).not.toMatch(/Fixes|Closes|Resolves/);
});
