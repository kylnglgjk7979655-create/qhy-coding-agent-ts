import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate } from '../.sandcastle/agent-workflows/shared/common.js';
import { qaOutputSchema, qaVerdict, verifyEvidence } from '../.sandcastle/agent-workflows/qa-only/report.js';

const require = createRequire(import.meta.url);
const check = (status = 'pass', evidence = ['QA-001.log']) => ({
  id: 'QA-001', specReference: '#1 acceptance criterion 1',
  steps: '启动 CLI，输入指令，检查文件', expected: '文件内容为 done', actual: '文件内容为 done',
  status, evidence,
});
const output = (checks: unknown[]) => ({ spec: '#1 Fixture', summary: '已执行本地验收。', checks });

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

  it('证据必须存在且非空，不能逃出本轮 artifact 或通过 symlink 引用外部文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-evidence-'));
    try {
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts);
      await writeFile(join(artifacts, 'QA-001.log'), '实际 CLI 输出');
      await writeFile(join(artifacts, 'empty.log'), '');
      await writeFile(join(root, 'outside.log'), '不属于本轮证据');
      await symlink(join(root, 'outside.log'), join(artifacts, 'linked.log'));
      expect(() => verifyEvidence(validate(qaOutputSchema, output([check()])), artifacts)).not.toThrow();
      for (const file of ['missing.log', 'empty.log', '../outside.log', 'linked.log']) {
        expect(() => verifyEvidence(validate(qaOutputSchema, output([check('pass', [file])])), artifacts)).toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qa-only-runner-'));
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
const session = 'fixture-qa-only';
const sessions = path.join(process.env.CODEX_HOME,'sessions','2026','11','11');
fs.mkdirSync(sessions,{recursive:true});
fs.writeFileSync(path.join(sessions,'rollout-'+session+'.jsonl'), JSON.stringify({type:'session_meta',payload:{id:session,cwd:process.cwd()}})+'\\n');
const mode = process.env.FIXTURE_MODE;
let text = '<promise>COMPLETE</promise>';
if (!args.includes('resume')) {
  const artifact = path.join(process.env.OUTPUT_DIR,'qa-only');
  fs.writeFileSync(path.join(artifact,'qa-plan.md'),'QA-001: CLI 应写入 done');
  if (mode !== 'missing-evidence') fs.writeFileSync(path.join(artifact,'QA-001.log'),'exit=0; 文件内容 done');
  if (mode === 'mutate') fs.writeFileSync('product.txt','unauthorized change');
  if (mode === 'untracked') fs.writeFileSync('unexpected.ts','unauthorized new source');
  if (mode === 'commit') {
    fs.writeFileSync('product.txt','unauthorized commit');
    cp.execFileSync('git',['add','product.txt']);
    cp.execFileSync('git',['commit','-m','fix: forbidden QA commit']);
  }
} else {
  const status = mode === 'fail' ? 'fail' : mode === 'blocked' ? 'blocked' : 'pass';
  const check = {id:'QA-001',specReference:'#1 CLI 写入 done',steps:'启动 CLI 并观察文件',expected:'done',actual:status === 'blocked' ? '缺少所需服务' : status === 'fail' ? '观察到错误结果' : 'done',status,evidence:status === 'blocked' ? [] : ['QA-001.log']};
  text = '<output>'+JSON.stringify({spec:'#1 Fixture spec',summary:'本地行为验收。',checks:mode === 'empty' ? [] : [check],findings:[],humanQa:['真实模型语义尚未人工验收。']})+'</output>';
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
      fileURLToPath(new URL('../.sandcastle/agent-workflows/qa-only/qa-only.ts', import.meta.url)),
    ], { cwd: work, env: { ...env, FIXTURE_MODE: mode, ...overrides }, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('QA Only 的真实 runner 与提取协议', () => {
  it('显式调用 skill、传完整 spec，发布文件绑定 HEAD，产品和 GitHub 保持只读', async () => {
    const h = await fixture();
    try {
      h.run();
      const result = JSON.parse(await readFile(join(h.artifacts, 'qa-only', 'result.json'), 'utf8'));
      expect(result).toMatchObject({ testedHead: h.head, fixedPoint: 'main', verdict: 'pass' });
      const report = await readFile(join(h.artifacts, 'qa-only', 'report.md'), 'utf8');
      expect(report).toContain(h.head);
      expect(report).toContain('真实模型语义尚未人工验收');
      const calls = (await readFile(join(h.directory, 'codex.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { extract: boolean; prompt: string });
      expect(calls.map((call) => call.extract)).toEqual([false, true]);
      expect(calls[0]?.prompt).toContain('使用 $qa-only skill');
      expect(calls[0]?.prompt).toContain('CLI 应写入 done');
      expect(calls[0]?.prompt).toContain(h.head);
      const githubCalls = (await readFile(join(h.directory, 'gh.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(githubCalls.every((args) => args[0] === 'api' || (args[0] === 'pr' && args[1] === 'view'))).toBe(true);
      expect(h.git('rev-parse', 'HEAD')).toBe(h.head);
      expect(h.git('status', '--porcelain')).toBe('');
    } finally { await h.cleanup(); }
  }, 60_000);

  it.each(['fail', 'blocked', 'empty'])('保留 %s 的验收结果，不擅自修复或伪造通过', async (mode) => {
    const h = await fixture();
    try {
      h.run(mode);
      expect(await readFile(join(h.artifacts, 'qa-only', 'verdict.txt'), 'utf8'))
        .toBe(mode === 'fail' ? 'fail' : 'blocked');
      expect(h.git('status', '--porcelain')).toBe('');
    } finally { await h.cleanup(); }
  }, 60_000);

  it.each(['mutate', 'untracked', 'commit', 'missing-evidence'])('拒绝为 %s 发布有效报告', async (mode) => {
    const h = await fixture();
    try {
      expect(() => h.run(mode)).toThrow(mode === 'missing-evidence' ? /ENOENT/u : /qa-only 修改了产品文件或提交/u);
      await expect(readFile(join(h.artifacts, 'qa-only', 'result.json'))).rejects.toThrow();
      if (mode !== 'commit') expect(h.git('rev-parse', 'HEAD')).toBe(h.head);
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
      const reportPath = join(h.artifacts, 'qa-only', 'report.md');
      const first = await readFile(reportPath, 'utf8');
      expect(() => h.run()).toThrow(/EEXIST/u);
      expect(await readFile(reportPath, 'utf8')).toBe(first);
    } finally { await h.cleanup(); }
  }, 60_000);
});
