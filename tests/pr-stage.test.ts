import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const queue = require('../.github/scripts/task-queue.cjs') as {
  decodeRequest: (body: string) => { kind: string; workflow: string; inputs: Record<string, string> } | undefined;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pr-stage-'));
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(work), mkdir(bin)]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-b', 'agent/fixture');
  git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@localhost');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(work, 'product'), 'fixture');
  git('add', '.'); git('commit', '-m', 'test: fixture');
  const head = git('rev-parse', 'HEAD');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const method = args.includes('--method') ? args[args.indexOf('--method')+1] : 'GET';
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0,'utf8')) : undefined;
const resource = args.find(arg => arg.startsWith('repos/')).split('?')[0];
fs.appendFileSync(process.env.CALLS,JSON.stringify({method,resource,body,usesBuiltinToken:process.env.GH_TOKEN==='fixture-builtin'})+'\\n');
if (resource.endsWith('/pulls/2')) console.log(JSON.stringify({state:process.env.MODE==='closed'?'closed':'open',head:{ref:'agent/fixture',sha:process.env.MODE==='stale'?'a'.repeat(40):process.env.HEAD_SHA,repo:{full_name:process.env.MODE==='fork'?'fork/repo':'owner/repo'}}}));
else if (resource.includes('/comments') && method==='GET') console.log('[[]]');
else console.log('null');
`, { mode: 0o755 });
  return {
    head,
    run: (stage: string, mode = 'pass', pat = '') => execFileSync(process.execPath, [
      '--import', require.resolve('tsx'),
      fileURLToPath(new URL('../.sandcastle/agent-workflows/tickets/control.ts', import.meta.url)), stage,
    ], { cwd: work, env: {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GH_REPO: 'owner/repo',
      GH_TOKEN: 'fixture-builtin', AGENT_PAT: pat, PR_NUMBER: '2', BRANCH: 'agent/fixture',
      HEAD_SHA: head, MODE: mode, CALLS: join(root, 'calls.jsonl'), GITHUB_RUN_ID: '123', OUTPUT_DIR: join(root, 'output'),
    }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }),
    calls: async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      method: string; resource: string; body?: { body?: string; labels?: string[] }; usesBuiltinToken: boolean;
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('implement → CR → QA 的内部接续', () => {
  it.each(['', 'fixture-pat'])('实现发起 CR 时保留 QA 接续，不因 PAT 配置重复入队：%s', async (pat) => {
    const h = await fixture();
    try {
      h.run('review', 'pass', pat);
      const calls = await h.calls();
      const comments = calls.filter((call) => call.resource.endsWith('/comments') && call.method === 'POST');
      expect(comments).toHaveLength(1);
      expect(queue.decodeRequest(comments[0]!.body!.body!)).toMatchObject({
        kind: 'review', workflow: 'agent-review.yml',
        inputs: { expected_head_sha: h.head, qa_after_review: 'true', authorization_label: 'agent:review' },
      });
      expect(calls.every((call) => call.usesBuiltinToken)).toBe(true);
      expect(calls.filter((call) => call.resource.endsWith('agent-queue.yml/dispatches'))).toHaveLength(1);
      expect(calls.filter((call) => call.resource.endsWith('check.yml/dispatches'))).toHaveLength(pat ? 0 : 1);
    } finally { await h.cleanup(); }
  });

  it('CR 接续的是可修复 QA，不是 QA Only，也不建立新的 CR 外层循环', async () => {
    const h = await fixture();
    try {
      h.run('qa');
      const calls = await h.calls();
      const record = queue.decodeRequest(calls.find((call) => call.method === 'POST' && call.resource.endsWith('/comments'))!.body!.body!);
      expect(record).toMatchObject({ kind: 'qa', workflow: 'agent-qa.yml', inputs: { expected_head_sha: h.head, authorization_label: 'agent:qa' } });
      expect(record!.inputs.qa_after_review).toBeUndefined();
      expect(calls.find((call) => call.resource.endsWith('/labels'))?.body?.labels).toEqual(['agent:qa']);
    } finally { await h.cleanup(); }
  });

  it.each(['stale', 'closed', 'fork'])('PR 状态为 %s 时停止接续，不贴标签或启动队列', async (mode) => {
    const h = await fixture();
    try {
      expect(() => h.run('qa', mode)).toThrow('停止接续');
      expect((await h.calls()).every((call) => call.method === 'GET')).toBe(true);
    } finally { await h.cleanup(); }
  });

  it.each([undefined, 'false', 'true'])('队列授权从持久化记录读取 QA 接续：%s', async (flag) => {
    const source = readFileSync(new URL('../.github/actions/queue-authorization/action.yml', import.meta.url), 'utf8');
    const script = source.split('        script: |\n')[1]!.split('\n').map((line) => line.slice(10)).join('\n');
    const record = { version: 1, id: 'request', number: 2, kind: 'review', workflow: 'agent-review.yml', status: 'running', runId: 99,
      inputs: { authorization_label: 'agent:review', ...(flag === undefined ? {} : { qa_after_review: flag }) } };
    const outputs: Record<string, string> = {};
    const execute = new Function('github', 'context', 'core', 'process', `return (async () => {${script}\n})();`) as (...args: unknown[]) => Promise<void>;
    await execute({
      paginate: async () => [{ user: { login: 'github-actions[bot]' }, body: `<!-- agent-subscription-queue:v1 ${Buffer.from(JSON.stringify(record)).toString('base64')} -->` }],
      rest: { issues: { listComments: {}, get: async () => ({ data: { state: 'open', labels: ['agent:review'] } }) } },
    }, { repo: { owner: 'owner', repo: 'repo' }, runId: 99 }, { setOutput: (key: string, value: string) => { outputs[key] = value; } }, {
      env: { ITEM_NUMBER: '2', QUEUE_REQUEST_ID: 'request', EXPECTED_WORKFLOW: 'agent-review.yml' },
    });
    expect(outputs['qa-after-review']).toBe(flag === 'true' ? 'true' : 'false');
  });
});
