import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate } from '../.sandcastle/agent-workflows/shared/common.js';
import { qaWorkflowOutputSchema as qaOutputSchema, qaVerdict, renderQaReport } from '../.sandcastle/agent-workflows/qa/report.js';

const require = createRequire(import.meta.url);
const check = (status = 'pass', evidence = ['QA-001.log']) => ({
  id: 'QA-001', specReference: '#1 acceptance criterion 1',
  steps: '启动 CLI，输入指令，检查文件', expected: '文件内容为 done', actual: '文件内容为 done',
  status, evidence,
});
const output = (checks: unknown[]) => ({ spec: '#1 Fixture', summary: '已执行本地验收。', checks, testedHead: 'a'.repeat(40), reviewedHead: null, reviewSummary: '无需新增 CR', repairs: [], unresolvedFindings: [] });

describe('QA 结果及证据', () => {
  it('总结果保留失败与未完成项，空计划不能通过', () => {
    const verdict = (...entries: unknown[]) => qaVerdict(validate(qaOutputSchema, output(entries)));
    expect(verdict(check())).toBe('pass');
    expect(verdict()).toBe('blocked');
    expect(verdict(check(), { ...check('blocked', []), id: 'QA-002' })).toBe('blocked');
    expect(verdict(check('not-run', []))).toBe('blocked');
    expect(verdict(check('fail'), { ...check('blocked', []), id: 'QA-002' })).toBe('fail');
  });

  it('拒绝重复检查、无证据的通过结果及不完整的执行记录', () => {
    expect(() => validate(qaOutputSchema, output([check(), check()]))).toThrow('重复');
    expect(() => validate(qaOutputSchema, output([check('pass', [])]))).toThrow('证据');
    expect(() => validate(qaOutputSchema, output([{ ...check(), actual: '' }]))).toThrow('actual');
  });

  it('达到最大修复次数或仍有 CR findings 时不能通过，并写入最终报告', () => {
    const result = validate(qaOutputSchema, {
      ...output([check()]), repairs: [{ issue: 'CLI 结果错误', attempts: 3, resolved: false, commits: [] }],
      unresolvedFindings: ['第三次修复后仍未通过 CR'],
    });
    expect(qaVerdict(result)).toBe('fail');
    const report = renderQaReport(result, 'a'.repeat(40), 'a'.repeat(40));
    expect(report).toContain('3/3');
    expect(report).toContain('达到最大修复次数');
    expect(report).toContain('第三次修复后仍未通过 CR');
  });

});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qa-runner-'));
  const work = join(directory, 'work');
  const bin = join(directory, 'bin');
  const artifacts = join(directory, 'output');
  await Promise.all([mkdir(work), mkdir(bin), mkdir(artifacts)]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(work, 'product.txt'), 'before\n');
  git('add', '.'); git('commit', '-m', 'test: baseline');
  git('checkout', '-b', 'agent/qa-fixture');
  await writeFile(join(work, 'product.txt'), 'after\n');
  git('add', '.'); git('commit', '-m', 'fix: fixture closes #1');
  const head = git('rev-parse', 'HEAD');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args)+'\\n');
if (args[0] === 'pr') console.log(JSON.stringify({title:'QA fixture',body:'Closes #1',comments:[]}));
else if (args[1] === 'graphql' && args.some(arg => arg.includes('parent{number}'))) console.log(JSON.stringify({data:{repository:{issue:{parent:null}}}}));
else if (args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else if (args[0] === 'api' && args.includes('repos/owner/repo/issues/1')) console.log(JSON.stringify({id:1,number:1,title:'Fixture spec',body:'CLI 应写入 done',state:'open',state_reason:null,labels:[],user:{login:'human'}}));
else if (args[0] === 'api') console.log(args.includes('--paginate') ? '[[]]' : '[]');
else throw new Error('Unexpected GitHub mutation');
`, { mode: 0o755 });
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] !== 'exec') throw new Error('Unexpected Codex command');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CODEX_CALLS, JSON.stringify({extract:args.includes('resume'),prompt})+'\\n');
const session = 'fixture-qa';
const sessions = path.join(process.env.CODEX_HOME,'sessions','2026','11','11');
fs.mkdirSync(sessions,{recursive:true});
fs.writeFileSync(path.join(sessions,'rollout-'+session+'.jsonl'), JSON.stringify({type:'session_meta',payload:{id:session,cwd:process.cwd()}})+'\\n');
const mode = process.env.FIXTURE_MODE;
let text = '<promise>COMPLETE</promise>';
if (!args.includes('resume')) {
  const artifact = path.join(process.env.OUTPUT_DIR,'qa');
  fs.writeFileSync(path.join(artifact,'qa-plan.md'),'QA-001: CLI 应写入 done');
  if (mode !== 'missing-evidence') fs.writeFileSync(path.join(artifact,'QA-001.log'),'exit=0; 文件内容 done');
  if (mode === 'mutate') fs.writeFileSync('product.txt','unauthorized change');
  if (mode === 'untracked') fs.writeFileSync('unexpected.ts','unauthorized new source');
  if (['commit','stale-test','stale-review','fail-with-repair'].includes(mode)) {
    fs.writeFileSync('product.txt','repaired product');
    cp.execFileSync('git',['add','product.txt']);
    cp.execFileSync('git',['commit','-m','fix: repair QA finding']);
  }
} else {
  const status = ['fail','fail-with-repair'].includes(mode) ? 'fail' : mode === 'blocked' ? 'blocked' : 'pass';
  const check = {id:'QA-001',specReference:'#1 CLI 写入 done',steps:'启动 CLI 并观察文件',expected:'done',actual:status === 'blocked' ? '缺少所需服务' : status === 'fail' ? '观察到错误结果' : 'done',status,evidence:status === 'blocked' ? [] : ['QA-001.log']};
  text = '<output>'+JSON.stringify({spec:'#1 Fixture spec',summary:'本地行为验收。',checks:mode === 'empty' ? [] : [check],findings:[],humanQa:['真实模型语义尚未人工验收。'],
    testedHead: mode === 'stale-test' ? process.env.BRANCH_HEAD_SHA : cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    reviewedHead: ['commit','stale-test'].includes(mode) ? cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() : null,
    reviewSummary: mode === 'commit' ? '修复已通过 CR' : '无通过的修复 CR',
    repairs: ['commit','stale-test','stale-review'].includes(mode) ? [{issue:'CLI 缺陷',attempts:1,resolved:true,commits:[cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]}] : mode === 'max-attempts' ? [{issue:'CLI 缺陷',attempts:3,resolved:false,commits:[]}] : [],
    unresolvedFindings: mode === 'max-attempts' ? ['达到最大次数后仍未解决'] : []})+'</output>';
}
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
    GH_TOKEN: 'fixture', GH_REPO: 'owner/repo', GH_CALLS: join(directory, 'gh.jsonl'),
    CODEX_HOME: join(directory, 'codex-home'), CODEX_MODEL: 'fixture-model', CODEX_AUTH_MODE: 'chatgpt',
    CODEX_CALLS: join(directory, 'codex.jsonl'), OUTPUT_DIR: artifacts,
    PR_NUMBER: '2', BRANCH: 'agent/qa-fixture', BRANCH_HEAD_SHA: head,
  };
  return {
    directory, work, artifacts, head, git,
    run: (mode = 'pass', overrides: Record<string, string> = {}) => execFileSync(process.execPath, [
      '--import', require.resolve('tsx'),
      fileURLToPath(new URL('../.sandcastle/agent-workflows/qa/qa.ts', import.meta.url)),
    ], { cwd: work, env: { ...env, FIXTURE_MODE: mode, ...overrides }, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('QA 的真实 runner 与提取协议', () => {
  it('显式调用 skill、传完整 spec，发布文件绑定 HEAD，产品和 GitHub 保持只读', async () => {
    const h = await fixture();
    try {
      h.run();
      const result = JSON.parse(await readFile(join(h.artifacts, 'qa', 'result.json'), 'utf8'));
      expect(result).toMatchObject({ testedHead: h.head, fixedPoint: 'main', verdict: 'pass' });
      const report = await readFile(join(h.artifacts, 'qa', 'report.md'), 'utf8');
      expect(report).toContain(h.head);
      expect(report).toContain('真实模型语义尚未人工验收');
      const calls = (await readFile(join(h.directory, 'codex.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { extract: boolean; prompt: string });
      expect(calls.map((call) => call.extract)).toEqual([false, true]);
      expect(calls[0]?.prompt).toContain('使用 `$qa-only` skill');
      expect(calls[0]?.prompt).toContain('CLI 应写入 done');
      expect(calls[0]?.prompt).toContain(h.head);
      const githubCalls = (await readFile(join(h.directory, 'gh.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(githubCalls.every((args) => args[0] === 'api' || (args[0] === 'pr' && args[1] === 'view'))).toBe(true);
      expect(h.git('rev-parse', 'HEAD')).toBe(h.head);
      expect(h.git('status', '--porcelain')).toBe('');
    } finally { await h.cleanup(); }
  }, 60_000);

  it.each(['fail', 'blocked', 'empty', 'max-attempts', 'fail-with-repair'])('保留 %s 的验收结果，不擅自修复或伪造通过', async (mode) => {
    const h = await fixture();
    try {
      h.run(mode);
      expect(await readFile(join(h.artifacts, 'qa', 'verdict.txt'), 'utf8'))
        .toBe(['fail', 'max-attempts', 'fail-with-repair'].includes(mode) ? 'fail' : 'blocked');
      expect(h.git('status', '--porcelain')).toBe('');
    } finally { await h.cleanup(); }
  }, 60_000);

  it.each(['mutate', 'untracked', 'missing-evidence', 'stale-test', 'stale-review'])('拒绝为 %s 发布有效报告', async (mode) => {
    const h = await fixture();
    try {
      expect(() => h.run(mode)).toThrow(mode === 'missing-evidence' ? /ENOENT/u : mode === 'stale-test' ? /未验收最终 HEAD/u : mode === 'stale-review' ? /缺少通过的 CR/u : /产品修改必须提交/u);
      await expect(readFile(join(h.artifacts, 'qa', 'result.json'))).rejects.toThrow();
      if (['mutate', 'untracked', 'missing-evidence'].includes(mode)) expect(h.git('rev-parse', 'HEAD')).toBe(h.head);
    } finally { await h.cleanup(); }
  }, 60_000);

  it('允许实现 subagent 提交的修复；最终提交经 CR 和 QA 后才能报告通过', async () => {
    const h = await fixture();
    try {
      h.run('commit');
      const finalHead = h.git('rev-parse', 'HEAD');
      expect(finalHead).not.toBe(h.head);
      const result = JSON.parse(await readFile(join(h.artifacts, 'qa', 'result.json'), 'utf8'));
      expect(result).toMatchObject({ initialHead: h.head, finalHead, testedHead: finalHead, reviewedHead: finalHead, verdict: 'pass' });
      expect(await readFile(join(h.artifacts, 'qa', 'report.md'), 'utf8')).toContain('修复已通过 CR');
    } finally { await h.cleanup(); }
  }, 60_000);

  it('检出 HEAD 与排队授权不一致时，运行模型前终止', async () => {
    const h = await fixture();
    try {
      expect(() => h.run('pass', { BRANCH_HEAD_SHA: 'a'.repeat(40) })).toThrow('检出版本与授权的 PR HEAD 不一致');
      await expect(readFile(join(h.directory, 'codex.jsonl'))).rejects.toThrow();
    } finally { await h.cleanup(); }
  }, 60_000);

  it('重复运行不能覆盖旧报告，必须使用新的输出目录', async () => {
    const h = await fixture();
    try {
      h.run();
      const reportPath = join(h.artifacts, 'qa', 'report.md');
      const first = await readFile(reportPath, 'utf8');
      expect(() => h.run()).toThrow(/EEXIST/u);
      expect(await readFile(reportPath, 'utf8')).toBe(first);
    } finally { await h.cleanup(); }
  }, 60_000);
});
