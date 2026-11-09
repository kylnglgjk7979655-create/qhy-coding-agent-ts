import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHub } from '../.sandcastle/agent-workflows/tickets/github.js';
import { fetchIssueContext } from '../.sandcastle/agent-workflows/shared/issue-context.js';

let root: string;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it('从旧 PR 关联的子票定位父 PRD，包含分页后的全部子票、正文、状态和评论', () => {
  root = mkdtempSync(join(tmpdir(), 'review-spec-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('./helpers/ticket-github-fixture.cjs', import.meta.url), join(bin, 'gh'));
  chmodSync(join(bin, 'gh'), 0o755);
  const issue = (number: number) => ({
    id: number, number, title: `需求 ${number}`, body: `验收标准 ${number}`, state: 'closed',
    state_reason: 'completed', labels: [], user: { login: 'human' },
  });
  const children = Array.from({ length: 102 }, (_, index) => issue(index + 24));
  const state = {
    issues: Object.fromEntries([issue(23), ...children].map((entry) => [entry.number, entry])),
    parents: Object.fromEntries(children.map((entry) => [entry.number, 23])), blockers: {}, pulls: [], requests: [],
    comments: { 23: [{ body: '父需求范围约束' }], 125: [{ body: '最后一票补充验收' }] },
  };
  const file = join(root, 'state.json'); writeFileSync(file, JSON.stringify(state));
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  vi.stubEnv('TICKET_FIXTURE', file);
  const spec = fetchIssueContext(24, new GitHub('owner/repo'));
  expect(spec.issueNumber).toBe('23');
  expect(spec.linkedIssue).toContain('父需求范围约束');
  expect(spec.linkedIssue).toContain('验收标准 125');
  expect(spec.linkedIssue).toContain('最后一票补充验收');
  expect(spec.linkedIssue).toContain('closed / completed');
  expect(spec.linkedIssue.match(/^## #/gmu)).toHaveLength(103);
  const requests = JSON.parse(readFileSync(file, 'utf8')).requests as { method: string }[];
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
});
