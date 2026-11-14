import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const processes: ReturnType<typeof spawn>[] = [];
let directory = '';
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill('SIGTERM');
    await closed;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('独立 QA 入口生成可运行的配置和历史，CLI 无需真实模型即可验证摘要及跨轮定义刷新', async () => {
  directory = await mkdtemp(join(tmpdir(), 'qhy-qa-launch-'));
  const root = join(directory, 'session');
  const fixture = spawn(process.execPath, ['--import', 'tsx', resolve('tests/helpers/local-qa-fixture.ts'), '--directory', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  processes.push(fixture);
  let output = '', errors = '';
  fixture.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  fixture.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  await expect.poll(() => output, { timeout: 5000 }).toContain('QA_READY');
  expect(errors).toBe('');
  async function run(command: string, conversation = 'qa-summary', expected = `夹具完成：${command}`) {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), '--workspace', 'work', '--conversation-id', conversation], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, TEST_MODEL_API_KEY: 'fake-model', QA_MCP_HEADER: 'fake-header' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    processes.push(child);
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.stdin.end(command + '\n/exit\n');
    expect(await closed, text).toBe(0);
    expect(text).toContain(expected);
    expect(text).not.toMatch(/CONTEXT_ERROR|APPROVAL_ERROR|PROVIDER_ERROR/);
  }
  await run('growth', 'qa-summary', '夹具完成：压缩后继续');
  const historyPath = join(root, '.agent/conversations/qa-summary.json');
  const saved = await readFile(historyPath, 'utf8');
  expect(saved).toContain('[对话摘要]');
  expect(saved).not.toContain('原文标记');
  expect(await readdir(join(root, '.agent/conversations'))).toEqual(['qa-summary.json']);
  if (process.platform !== 'win32') expect((await stat(historyPath)).mode & 0o777).toBe(0o600);
  fixture.stdin.write('schema-v2\nstatus\n');
  await expect.poll(() => output).toContain('"summaryRequests":1');
  await run('remote', 'qa-remote');
  const remoteHistory = await readFile(join(root, '.agent/conversations/qa-remote.json'), 'utf8');
  expect(remoteHistory).toContain('新版参数');
  expect(remoteHistory).toContain('正常参数');
  expect(remoteHistory).not.toContain('fake-header');
  expect((await readFile(join(root, 'work/worker.cjs'), 'utf8'))).toContain('child.pid');
  expect((await readFile(join(root, 'work/.agent/settings.json'), 'utf8'))).toContain('QA_MCP_HEADER');
});
