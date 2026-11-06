import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('真实 Sandcastle 通过假 Codex CLI 跑完两个独立审查及修复，不使用真实登录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-task-smoke-'));
  try {
    const work = join(root, 'work'); const bin = join(root, 'bin'); const output = join(root, 'output');
    await mkdir(work); await mkdir(bin);
    await writeFile(join(work, '.gitignore'), '.sandcastle/\n');
    await writeFile(join(work, 'a.txt'), 'fixture\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
    git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    const context = join(root, 'task.json'); const calls = join(root, 'calls.jsonl');
    await writeFile(context, JSON.stringify({ mode: 'review', sha, baseSha: sha, pr: { number: 1 }, linkedIssues: [] }));
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({models:[{slug:'mock-model'}]})); process.exit(0); }
if (args[0] !== 'exec') throw new Error('unexpected command');
const prompt = fs.readFileSync(0,'utf8');
const axis = prompt.includes('本次仅执行 code-review 的 Standards 轴') ? 'Standards' : prompt.includes('本次仅执行 code-review 的 Spec 轴') ? 'Spec' : 'repair';
fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({axis,args})+'\\n');
const result = axis === 'repair' ? {summary:'Standards / Spec 已完成，假 CLI 验证通过',inlineComments:[],replies:[]} : {report:axis+'独立报告'};
const sessions = require('node:path').join(process.env.CODEX_HOME,'sessions','2026','01','01');
fs.mkdirSync(sessions, {recursive:true});
fs.writeFileSync(require('node:path').join(sessions, 'rollout-test-'+axis+'.jsonl'), JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:1234},model_context_window:10000}}}));
console.log(JSON.stringify({type:'thread.started',thread_id:axis}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'<output>'+JSON.stringify(result)+'</output>'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o755 });
    const logs = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../.sandcastle/task.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ALLOW_HOST_EXECUTION: '1', TASK_CONTEXT_PATH: context, AGENT_WORKSPACE: work, AGENT_OUTPUT_DIR: output, CODEX_HOME: join(root, 'fake-home'), CODEX_AUTH_MODE: 'chatgpt', CODEX_MODEL: 'mock-model', MOCK_CALLS: calls, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    expect(logs.match(/Codex 模型：mock-model/g)).toHaveLength(3);
    expect(logs.match(/Codex 上下文：1234 tokens \/ 10000 tokens/g)).toHaveLength(3);
    const events = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { axis: string; args: string[] });
    expect(events.map((event) => event.axis)).toEqual(['Standards', 'Spec', 'repair']);
    expect(events.every((event) => !event.args.includes('resume'))).toBe(true);
    const summary = JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).summary;
    expect(summary).toContain('假 CLI 验证通过'); expect(summary).toContain('Standards独立报告'); expect(summary).toContain('Spec独立报告');
    expect(git('status', '--porcelain')).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35000);
