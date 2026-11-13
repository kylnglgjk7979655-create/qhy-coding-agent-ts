import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parsePlan, planFromDraft } from '../.sandcastle/agent-workflows/tickets/plan.js';

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL('../.sandcastle/agent-workflows/tickets/', import.meta.url));
interface FixtureIssue {
  id: number; number: number; title: string; body: string; labels: string[];
  state: string; state_reason: string | null; user: { login: string };
}
interface FixtureComment {
  id: number; body: string; created_at: string; updated_at: string; user: { login: string; type: string };
}
interface State {
  issues: Record<number, FixtureIssue>; parents: Record<number, number>; blockers: Record<number, number[]>;
  comments: Record<number, FixtureComment[]>; pulls: { number: number; state?: string; body: string; base: { ref: string }; head?: { ref: string; sha?: string; repo?: { full_name: string } }; draft?: boolean; labels?: { name: string }[] }[];
  requests: { method: string; resource: string; token: string; body?: unknown }[]; failNext?: string;
  runs?: { path: string; status: string }[];
}
const issue = (number: number, labels: string[] = []): FixtureIssue => ({
  id: 1000000000 + number, number, title: `任务 ${number}`, body: 'GitHub 中的规格。', labels,
  state: 'open', state_reason: null, user: { login: 'maintainer' },
});
const draft = { slices: [
  { key: 'create', title: '创建会话', whatToBuild: '从 CLI 建立并继续会话。', acceptanceCriteria: ['跨进程续聊通过测试。'], blockedBy: [] },
  { key: 'resume', title: '恢复会话', whatToBuild: '从 CLI 恢复工作现场。', acceptanceCriteria: ['恢复行为通过测试。'], blockedBy: ['create'] },
] };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ticket-workflows-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const stateFile = join(root, 'github.json');
  const envFile = join(root, 'environment');
  const outputFile = join(root, 'output');
  const planFile = join(root, 'plan.json');
  const sourceFile = join(root, 'source.json');
  copyFileSync(fileURLToPath(new URL('./helpers/ticket-github-fixture.cjs', import.meta.url)), join(bin, 'gh'));
  chmodSync(join(bin, 'gh'), 0o755);
  const write = (state: State) => writeFileSync(stateFile, JSON.stringify(state));
  const read = (): State => JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  const update = (change: (state: State) => void) => { const state = read(); change(state); write(state); };
  write({ issues: { 23: issue(23, ['agent:to-issues']) }, parents: {}, blockers: {}, comments: {}, pulls: [], requests: [] });
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TICKET_FIXTURE: stateFile,
    GH_TOKEN: 'github-token', AGENT_PAT: 'dispatch-token', GH_REPO: 'owner/repo', ISSUE_NUMBER: '23',
    OUTPUT_DIR: root, GITHUB_ENV: envFile, GITHUB_OUTPUT: outputFile, SOURCE_FILE: sourceFile, PLAN_FILE: planFile,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  };
  const run = (mode: string, extra: Record<string, string> = {}) => {
    writeFileSync(envFile, ''); writeFileSync(outputFile, '');
    return spawnSync(process.execPath, ['--import', require.resolve('tsx'), join(directory, 'control.ts'), mode], {
      env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000,
    });
  };
  const ok = (mode: string, extra?: Record<string, string>) => {
    const result = run(mode, extra);
    expect(result.stderr, result.stdout).toBe(''); expect(result.status, result.stderr).toBe(0);
    return { output: readFileSync(outputFile, 'utf8'), environment: readFileSync(envFile, 'utf8'), stdout: result.stdout };
  };
  const plan = () => {
    ok('snapshot');
    const source = JSON.parse(readFileSync(sourceFile, 'utf8')) as { source_hash: string };
    writeFileSync(planFile, JSON.stringify(planFromDraft(draft, 23, source.source_hash)));
  };
  const publish = () => { plan(); ok('publish'); ok('finish-plan'); };
  return { root, env, read, update, run, ok, plan, publish, sourceFile, planFile };
}

describe('GitHub 自动拆票和依赖队列的真实控制脚本', () => {
  it('自动创建子票前核对来源快照，需求变化时不产生副作用', () => {
    const h = harness(); h.plan();
    expect(Object.keys(h.read().issues)).toEqual(['23']);
    h.update((state) => { state.issues[23]!.body += ' 新的需求。'; });
    const failed = h.run('publish');
    expect(failed.status).toBe(1); expect(failed.stderr).toContain('变化');
    expect(Object.keys(h.read().issues)).toEqual(['23']);
  });

  it('输出来源不匹配、依赖循环和不存在的前置不能发布', () => {
    const h = harness(); h.plan();
    const plan = JSON.parse(readFileSync(h.planFile, 'utf8')) as { source_hash: string };
    plan.source_hash = '0'.repeat(64); writeFileSync(h.planFile, JSON.stringify(plan));
    expect(h.run('publish').stderr).toContain('不匹配');
    const bad = planFromDraft(draft, 23, 'a'.repeat(64));
    bad.tickets[0]!.blocked_by = ['resume'];
    expect(() => parsePlan(bad)).toThrow('前置');
    bad.tickets[0]!.blocked_by = []; bad.tickets[1]!.blocked_by = ['missing'];
    expect(() => parsePlan(bad)).toThrow('前置');
    expect(Object.keys(h.read().issues)).toHaveLength(1);
  });

  it('无需审批即创建原生子票及依赖，原型 JSON 代码块保持原样', () => {
    const h = harness(); h.ok('snapshot');
    const source = JSON.parse(readFileSync(h.sourceFile, 'utf8')) as { source_hash: string };
    const prototype = structuredClone(draft);
    prototype.slices[0]!.whatToBuild += '\n\n原型确认的状态：\n```json\n{"state":"ready"}\n```';
    writeFileSync(h.planFile, JSON.stringify(planFromDraft(prototype, 23, source.source_hash)));
    h.ok('publish'); h.ok('finish-plan');
    expect(h.read().issues[24]!.body).toContain('{"state":"ready"}');
    expect(h.read().parents).toEqual({ 24: 23, 25: 23 });
    expect(h.read().blockers[25]).toEqual([24]);
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
  });

  it('创建后挂接失败可重试，补齐原生父子关系和依赖而不重复建票', () => {
    const h = harness(); h.plan();
    h.update((state) => { state.failNext = 'GET issues/23/sub_issues'; });
    // 先在只读预检失败，不产生副作用。
    expect(h.run('publish').status).toBe(1);
    expect(Object.keys(h.read().issues)).toHaveLength(1);
    // 创建成功后在挂接阶段断开，再运行真正的发布命令恢复现场。
    h.update((state) => { state.failNext = 'POST issues/23/sub_issues'; });
    expect(h.run('publish').status).toBe(1);
    expect(Object.keys(h.read().issues)).toHaveLength(2);
    expect(h.read().parents).toEqual({});
    h.ok('publish');
    const state = h.read();
    expect(Object.keys(state.issues)).toHaveLength(3);
    expect(state.parents).toEqual({ 24: 23, 25: 23 });
    expect(state.blockers[25]).toEqual([24]);
    expect(state.issues[24]!.labels).toEqual(['ready-for-agent']);
    expect(state.issues[25]!.body).toContain('## Acceptance criteria');
    expect(state.issues[23]!.state).toBe('open');
    h.ok('publish');
    expect(Object.keys(h.read().issues)).toHaveLength(3);
    expect(h.read().blockers[25]).toEqual([24]);
  }, 30_000);

  it('父 implement 按依赖选择子票并通过 PAT 接续', () => {
    const h = harness(); h.publish();
    h.update((state) => { state.issues[23]!.labels.push('agent:implement'); });
    expect(h.ok('prepare').environment).toMatch(/ISSUE_NUMBER<<[^\n]+\n24\n/u);
    h.update((state) => {
      state.issues[24]!.labels = []; state.issues[24]!.state = 'closed'; state.issues[24]!.state_reason = 'completed';
      state.pulls = [{ number: 80, body: 'Closes #23', base: { ref: 'main' }, head: { ref: 'agent/parent-23', repo: { full_name: 'owner/repo' } } }];
    });
    h.ok('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23' });
    expect(h.ok('prepare').environment).toMatch(/ISSUE_NUMBER<<[^\n]+\n25\n/u);
  }, 30_000);

  it('仅由 Issue 关闭事件触发依赖推进，不定时扫描或监听模型工作流', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/agent-promote-queued.yml', import.meta.url)), 'utf8');
    expect(workflow).toContain('types: [closed]');
    expect(workflow).not.toMatch(/workflow_run:|schedule:|workflow_dispatch:/u);
    expect(workflow).toContain('github.event.issue.number');
  });

  it('子票完成后用 PAT 重新贴父票 implement；暂停和无剩余子票时不触发', () => {
    const h = harness(); h.publish();
    h.update((state) => {
      state.issues[23]!.labels.push('agent:queued');
      state.issues[24]!.state = 'closed'; state.issues[24]!.state_reason = 'completed';
      state.requests = [];
    });
    h.ok('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23' });
    expect(h.read().issues[23]!.labels).toContain('agent:implement');
    expect(h.read().requests).toContainEqual(expect.objectContaining({
      method: 'POST', resource: 'issues/23/labels', token: 'dispatch-token', body: { labels: ['agent:implement'] },
    }));
    h.update((state) => { state.issues[23]!.labels = ['agent:queued', 'agent:blocked']; state.requests = []; });
    h.ok('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23' });
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
    h.update((state) => { state.issues[23]!.labels = ['agent:queued']; state.issues[25]!.state = 'closed'; state.issues[25]!.state_reason = 'completed'; });
    h.ok('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23' });
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
  }, 30_000);

  it('子票未完成时拒绝接续；没有 AGENT_PAT 时拒绝接续而不是入队', () => {
    const h = harness(); h.publish();
    h.update((state) => { state.issues[23]!.labels.push('agent:queued'); });
    expect(h.run('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23' }).status).toBe(1);
    h.update((state) => { state.issues[24]!.state = 'closed'; state.issues[24]!.state_reason = 'completed'; });
    const failed = h.run('continue-parent', { ISSUE_NUMBER: '24', PARENT_NUMBER: '23', AGENT_PAT: '' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('AGENT_PAT');
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
  }, 30_000);

  it('拆票预检后立即切换执行标签', () => {
    const h = harness(); h.ok('snapshot');
    expect(h.read().issues[23]!.labels).toContain('agent:in-progress');
    expect(h.read().issues[23]!.labels).not.toContain('agent:to-issues');
  });

  it('子票直接 implement 也不能绕过依赖，API 读失败不会被当作无依赖', () => {
    const h = harness(); h.publish();
    h.update((state) => { state.issues[25]!.labels.push('agent:implement'); });
    expect(h.ok('prepare', { ISSUE_NUMBER: '25' }).output).toBe('proceed=false\n');
    expect(h.read().issues[25]!.labels).toContain('agent:queued');
    expect(h.read().issues[25]!.labels).not.toContain('agent:in-progress');
    h.update((state) => { state.issues[25]!.labels.push('agent:implement'); state.failNext = 'issues/25/dependencies/blocked_by'; });
    expect(h.run('prepare', { ISSUE_NUMBER: '25' }).status).toBe(1);
    expect(h.read().issues[25]!.labels).not.toContain('agent:in-progress');
  }, 30_000);

  it('仅推进完成的 Issue 的已排队直接依赖，检查其他前置条件', () => {
    const h = harness();
    h.update((state) => {
      state.issues[22] = issue(22); state.issues[22]!.state = 'closed'; state.issues[22]!.state_reason = 'not_planned';
      state.issues[23]!.labels = ['agent:queued']; state.blockers[23] = [22];
      state.issues[24] = issue(24, ['agent:queued']); state.blockers[24] = [22, 25]; state.issues[25] = issue(25);
      state.issues[26] = issue(26, ['agent:queued']);
    });
    h.ok('promote', { ISSUE_NUMBER: '22' });
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
    h.update((state) => { state.issues[22]!.state_reason = 'completed'; });
    h.ok('promote', { ISSUE_NUMBER: '22' });
    expect(h.read().issues[23]!.labels).toContain('agent:implement');
    expect(h.read().issues[24]!.labels).not.toContain('agent:implement');
    expect(h.read().issues[26]!.labels).not.toContain('agent:implement');
    expect(h.read().requests).toContainEqual(expect.objectContaining({
      method: 'POST', resource: 'issues/23/labels', token: 'dispatch-token', body: { labels: ['agent:implement'] },
    }));
    h.update((state) => { state.issues[23]!.labels = ['agent:queued']; state.requests = []; });
    const failed = h.run('promote', { ISSUE_NUMBER: '22', AGENT_PAT: '' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('AGENT_PAT');
    expect(h.read().issues[23]!.labels).not.toContain('agent:implement');
  }, 30_000);

  it('实现发起的 Review 用 PAT 重新贴标签，不写队列；没有 PAT 时拒绝接续', () => {
    const h = harness();
    h.update((state) => {
      state.issues[90] = issue(90);
      state.pulls = [{ number: 90, state: 'open', body: '', base: { ref: 'main' }, head: { ref: 'agent/issue-24', sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repo: { full_name: 'owner/repo' } } }];
    });
    h.ok('review', { PR_NUMBER: '90', BRANCH: 'agent/issue-24' });
    expect(h.read().requests).toContainEqual(expect.objectContaining({
      method: 'POST', resource: 'issues/90/labels', token: 'dispatch-token', body: { labels: ['agent:review'] },
    }));
    expect(h.read().requests.filter((entry) => entry.resource.endsWith('/dispatches'))).toEqual([]);
    h.update((state) => { state.requests = []; state.issues[90]!.labels = []; });
    const failed = h.run('review', { PR_NUMBER: '90', BRANCH: 'agent/issue-24', AGENT_PAT: '' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('AGENT_PAT');
    expect(h.read().issues[90]!.labels).toEqual([]);
  });

  it('失败子票不被自动重试，人工重加 implement 后才允许重试；推送前重新检查依赖', () => {
    const h = harness(); h.publish();
    h.update((state) => { state.issues[23]!.labels.push('agent:queued'); state.issues[24]!.labels.push('agent:blocked'); });
    h.update((state) => { state.issues[24]!.labels.push('agent:implement'); });
    expect(h.ok('prepare', { ISSUE_NUMBER: '24' }).output).toBe('proceed=true\n');
    h.ok('verify', { ISSUE_NUMBER: '24' });
    h.update((state) => { state.issues[23]!.labels.push('agent:blocked'); });
    expect(h.run('verify', { ISSUE_NUMBER: '24' }).status).toBe(1);
  }, 30_000);

  it('发布未完成的父需求阻止子票抢跑', () => {
    const h = harness(); h.publish();
    h.update((state) => {
      state.issues[23]!.labels.push('agent:to-issues'); state.issues[24]!.labels.push('agent:implement');
    });
    expect(h.ok('prepare', { ISSUE_NUMBER: '24' }).output).toBe('proceed=false\n');
  }, 30_000);

  it('Agent 从 GitHub 读取 PRD，输出与参考仓库对齐的 slices，不触发真实模型或发布', () => {
    const h = harness(); h.ok('snapshot');
    h.update((state) => { state.requests = []; });
    const work = join(h.root, 'work'); mkdirSync(work);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(work, 'README.md'), 'fixture'); git('add', '.'); git('commit', '-m', 'test: fixture');
    const claude = join(h.root, 'bin', 'claude');
    const emitted = join(h.root, 'draft.json'); writeFileSync(emitted, JSON.stringify(draft));
    writeFileSync(claude, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8'); fs.writeFileSync(process.env.MOCK_PROMPT, prompt);
const text = '<output>'+fs.readFileSync(process.env.MOCK_DRAFT,'utf8')+'</output>';
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-ticket'}));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));
console.log(JSON.stringify({type:'result',result:text}));
`, { mode: 0o755 });
    mkdirSync(join(h.root, 'home'), { recursive: true });
    const promptFile = join(h.root, 'prompt.txt');
    execFileSync(process.execPath, ['--import', require.resolve('tsx'), join(directory, 'to-issues.ts')], {
      cwd: work, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...h.env, HOME: join(h.root, 'home'), AGENT_MODEL: 'fixture-model', ANTHROPIC_AUTH_TOKEN: 'fixture-token', MOCK_PROMPT: promptFile, MOCK_DRAFT: emitted },
    });
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('gh issue view 23 --comments');
    expect(prompt).not.toContain('{{'); expect(prompt).not.toContain('SOURCE SNAPSHOT');
    const plan = parsePlan(JSON.parse(readFileSync(h.planFile, 'utf8')));
    expect(plan.parent).toBe(23); expect(plan.tickets[1]?.blocked_by).toEqual(['create']);
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(h.read().requests.every((entry) => entry.method === 'GET')).toBe(true);
  }, 45_000);
});
