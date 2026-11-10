import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBatch, planEffects, planSchema } from '../.sandcastle/agent-workflows/explore/batch.js';
import { validate } from '../.sandcastle/agent-workflows/shared/common.js';

const require = createRequire(import.meta.url);

describe('官方批量调查的发布边界', () => {
  const batch = parseBatch([
    { number: 2, title: '重复问题', author: { login: 'reporter' } },
    { number: 1, title: '原问题', author: { login: 'reporter' } },
  ]);
  const entry = (number: number, duplicate_of: number | null = null) => ({
    number, duplicate_of, tag: 'easy-call', comment: '已核对代码。',
  });

  it('不完整或重复的调查结果不能生成发布计划', () => {
    expect(() => validate(planSchema(batch), { issues: [entry(1)] })).toThrow('missing');
    expect(() => validate(planSchema(batch), { issues: [entry(1), entry(1)] })).toThrow('more than once');
    expect(() => validate(planSchema(batch), { issues: [entry(1), entry(2, 99)] })).toThrow('not in this batch');
  });

  it('拒绝循环重复关系；合法结果先转交保留项，再关闭重复项', () => {
    expect(() => validate(planSchema(batch), { issues: [entry(1, 2), entry(2, 1)] })).toThrow('itself a duplicate');
    const plan = validate(planSchema(batch), { issues: [entry(2, 1), entry(1)] });
    expect(planEffects(plan)).toEqual([
      { kind: 'comment', issue: 1, body: expect.stringContaining('agent:implement') },
      { kind: 'swap-label', issue: 1, to: 'agent:implement' },
      { kind: 'comment', issue: 2, body: expect.stringContaining('duplicate of #1') },
      { kind: 'close-duplicate', issue: 2, duplicateOf: 1 },
    ]);
  });
});

it('真实 Sandcastle 用订阅 Codex 接口完成提交、审查和同会话提取重试，不调用真实模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'official-sandcastle-smoke-'));
  try {
    const work = join(directory, 'work');
    const bin = join(directory, 'bin');
    const output = join(directory, 'output');
    const home = join(directory, 'codex-home');
    const calls = join(directory, 'calls.jsonl');
    await Promise.all([mkdir(work), mkdir(bin), mkdir(output)]);
    await writeFile(join(work, 'a.txt'), 'fixture\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    git('add', '.'); git('commit', '-m', 'test: initial');
    git('checkout', '-b', 'agent/issue-1-fixture');
    await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue') console.log('Issue #1: implement fixture');
else if (args[0] === 'pr') console.log(JSON.stringify({title:'Fixture PR',body:'Closes #1',comments:[]}));
else if (args[1] === 'graphql' && args.some(arg => arg.includes('parent{number}'))) console.log(JSON.stringify({data:{repository:{issue:{parent:null}}}}));
else if (args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:'thread',isResolved:false,comments:{nodes:[{id:'known-comment',path:'a.txt',line:2,body:'Please check',author:{login:'human'}}]}}]}}}}}));
else if (args[0] === 'api') {
  if (args.includes('repos/owner/repo/issues/1')) console.log(JSON.stringify({id:1,number:1,title:'Fixture',body:'完成 fixture',state:'open',state_reason:null,labels:[],user:{login:'human'}}));
  else console.log(args.includes('--paginate') ? '[[]]' : '[]');
}
else throw new Error('Unexpected gh command');
`, { mode: 0o755 });
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({models:[{slug:'fixture-model'}]})); process.exit(0); }
if (args[0] !== 'exec') throw new Error('Unexpected Codex command');
const prompt = fs.readFileSync(0, 'utf8');
const phase = args.includes('resume') ? 'extract' : prompt.includes('Implement issue #1') ? 'implement' : 'review';
const prior = fs.existsSync(process.env.MOCK_CALLS) ? fs.readFileSync(process.env.MOCK_CALLS,'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({phase,args,home:process.env.CODEX_HOME,apiKey:process.env.CODEX_API_KEY,openaiKey:process.env.OPENAI_API_KEY})+'\\n');
const sessionId = phase === 'implement' ? 'fixture-implement' : 'fixture-review';
const sessions = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '07');
fs.mkdirSync(sessions, {recursive:true});
fs.writeFileSync(path.join(sessions,'rollout-test-'+sessionId+'.jsonl'), JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:process.cwd()}})+'\\n');
let text = '<promise>COMPLETE</promise>';
if (phase === 'implement') {
  fs.appendFileSync('a.txt', 'implemented\\n');
  cp.execFileSync('git', ['add','a.txt']);
  cp.execFileSync('git', ['commit','-m','fix: implement fixture']);
  fs.writeFileSync(path.join(process.env.OUTPUT_DIR,'pr-metadata.json'),JSON.stringify({prTitle:'fix: fixture',prDescription:'## Summary\\n\\n修复 fixture。\\n\\n## Evidence\\n\\nBefore: 未记录。After: fixture 验证。\\n\\n## Merge Danger\\n\\nDoor: two-way; Blast Radius: fixture'}));
} else if (phase === 'extract') {
  const result = prior.some(e => e.phase === 'extract') ? {
    summary:'已审查并验证。',
    inlineComments:[{path:'a.txt',line:2,body:'有效评论'},{path:'missing.txt',line:99,body:'应被过滤'}],
    replies:[{commentId:'known-comment',body:'已处理'},{commentId:'unknown-comment',body:'应被过滤'}]
  } : {summary:''};
  text = '<output>'+JSON.stringify(result)+'</output>';
}
console.log(JSON.stringify({type:'thread.started',thread_id:sessionId}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
`, { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
      CODEX_HOME: home, CODEX_AUTH_MODE: 'chatgpt', CODEX_MODEL: '', CODEX_API_KEY: 'must-clear', OPENAI_API_KEY: 'must-clear',
      GH_TOKEN: 'fixture', GH_REPO: 'owner/repo', MOCK_CALLS: calls, OUTPUT_DIR: output,
      ISSUE_NUMBER: '1', ISSUE_TITLE: 'Fixture', PR_NUMBER: '2', PARENT_NUMBER: '', BRANCH: 'agent/issue-1-fixture',
    };
    const run = (mode: string) => execFileSync(process.execPath, [
      '--import', require.resolve('tsx'),
      fileURLToPath(new URL(`../.sandcastle/agent-workflows/${mode}/${mode}.ts`, import.meta.url)),
    ], { cwd: work, env, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    run('implement');
    expect(git('log', '-1', '--format=%s')).toBe('fix: implement fixture');
    expect(await readFile(join(output, 'pr_description.txt'), 'utf8')).toContain('Closes #1');
    run('review');
    const events = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      phase: string; args: string[]; home: string; apiKey: string; openaiKey: string;
    });
    expect(events.map((event) => event.phase)).toEqual(['implement', 'review', 'extract', 'extract']);
    for (const event of events) {
      expect(event.home).toBe(home);
      expect(event.apiKey).toBe(''); expect(event.openaiKey).toBe('');
      expect(event.args).toContain('fixture-model');
      if (event.phase === 'extract') expect(event.args).toContain('fixture-review');
    }
    expect(JSON.parse(await readFile(join(output, 'review_payload.json'), 'utf8'))).toEqual({
      event: 'COMMENT', commit_id: git('rev-parse', 'HEAD'), body: '已审查并验证。',
      comments: [{ path: 'a.txt', line: 2, side: 'RIGHT', body: '有效评论' }],
    });
    expect(JSON.parse(await readFile(join(output, 'replies.json'), 'utf8'))).toEqual([{ commentId: 'known-comment', body: '已处理' }]);
    expect(git('status', '--porcelain')).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
