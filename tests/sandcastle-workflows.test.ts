import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);

it('真实 Sandcastle 通过 Anthropic 兼容端点完成提交、审查和同会话提取重试，不调用真实模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'official-sandcastle-smoke-'));
  try {
    const work = join(directory, 'work');
    const bin = join(directory, 'bin');
    const output = join(directory, 'output');
    const home = join(directory, 'home');
    const calls = join(directory, 'calls.jsonl');
    await Promise.all([mkdir(work), mkdir(bin), mkdir(output), mkdir(home)]);
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
  if (args.includes('repos/{owner}/{repo}/pulls/2/reviews')) console.log('[]');
  else if (args.includes('repos/owner/repo/issues/1')) console.log(JSON.stringify({id:1,number:1,title:'Fixture',body:'完成 fixture',state:'open',state_reason:null,labels:[],user:{login:'human'}}));
  else console.log(args.includes('--paginate') ? '[[]]' : '[]');
}
else throw new Error('Unexpected gh command');
`, { mode: 0o755 });
    await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.readFileSync(0, 'utf8');
const phase = args.includes('--resume') ? 'extract' : 'main';
const prior = fs.existsSync(process.env.MOCK_CALLS) ? fs.readFileSync(process.env.MOCK_CALLS,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({
  phase, args,
  model: args[args.indexOf('--model') + 1],
  token: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  subagent: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
}) + '\\n');
const sessionId = 'fixture-session';
const encoded = process.cwd().replace(/[\\\\/]+$/,'').replace(/[^A-Za-z0-9]/g,'-');
const sessionDir = path.join(process.env.HOME, '.claude', 'projects', encoded);
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, sessionId + '.jsonl'), JSON.stringify({type:'assistant',message:{usage:{input_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId}));
let text = '<promise>COMPLETE</promise>';
if (process.env.FIXTURE_MODE === 'implement') {
  fs.appendFileSync('a.txt', 'implemented\\n');
  cp.execFileSync('git', ['add','a.txt']);
  cp.execFileSync('git', ['commit','-m','fix: implement fixture']);
  fs.writeFileSync(path.join(process.env.OUTPUT_DIR,'pr-metadata.json'),JSON.stringify({prTitle:'fix: fixture',prDescription:'## Summary\\n\\n修复 fixture。\\n\\n## Evidence\\n\\nBefore: 未记录。After: fixture 验证。\\n\\n## Merge Danger\\n\\nDoor: two-way; Blast Radius: fixture'}));
} else if (phase === 'extract') {
  const attempts = prior.filter(entry => entry.phase === 'extract').length;
  const result = attempts === 0 ? {summary:''} : {
    summary:'已审查并验证。',
    inlineComments:[{path:'a.txt',line:2,body:'有效评论'},{path:'missing.txt',line:99,body:'应被过滤'}],
    replies:[{commentId:'known-comment',body:'已处理'},{commentId:'unknown-comment',body:'应被过滤'}]
  };
  text = '<output>'+JSON.stringify(result)+'</output>';
}
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));
console.log(JSON.stringify({type:'result',result:text}));
`, { mode: 0o755 });
    // 测试固定使用默认模型与地址，不继承运行环境里的模型覆盖。
    const { AGENT_MODEL: _agentModel, ANTHROPIC_MODEL: _anthropicModel, CLAUDE_CODE_SUBAGENT_MODEL: _subagentModel, ...ambientEnv } = process.env;
    const baseEnv = {
      ...ambientEnv, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
      ANTHROPIC_AUTH_TOKEN: 'fixture-token', GH_TOKEN: 'fixture', GH_REPO: 'owner/repo', MOCK_CALLS: calls, OUTPUT_DIR: output,
      ISSUE_NUMBER: '1', ISSUE_TITLE: 'Fixture', PR_NUMBER: '2', PARENT_NUMBER: '', BRANCH: 'agent/issue-1-fixture',
    };
    const run = (mode: string, fixtureMode: string) => execFileSync(process.execPath, [
      '--import', require.resolve('tsx'),
      fileURLToPath(new URL(`../.sandcastle/agent-workflows/${mode}/${mode}.ts`, import.meta.url)),
    ], { cwd: work, env: { ...baseEnv, FIXTURE_MODE: fixtureMode }, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    run('implement', 'implement');
    expect(git('log', '-1', '--format=%s')).toBe('fix: implement fixture');
    expect(await readFile(join(output, 'pr_description.txt'), 'utf8')).toContain('Closes #1');
    run('review', 'review');
    const events = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      phase: string; args: string[]; model: string; token: string; baseURL: string; subagent: string;
    });
    expect(events.map((event) => event.phase)).toEqual(['main', 'main', 'extract', 'extract']);
    for (const event of events) {
      expect(event.model).toBe('deepseek-v4.1-flash');
      expect(event.token).toBe('fixture-token');
      expect(event.baseURL).toBe('https://qianfan.baidubce.com/anthropic/tokenplan/personal');
      expect(event.subagent).toBe('deepseek-v4.1-flash');
      expect(event.args).toContain('--dangerously-skip-permissions');
      if (event.phase === 'extract') expect(event.args).toContain('fixture-session');
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