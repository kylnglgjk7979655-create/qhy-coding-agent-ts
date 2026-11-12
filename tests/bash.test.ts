import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';

const cli = resolve('dist/cli.js');
let cwd = '';
let workspaceArgs: string[] = [];
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>;
const managedPids: number[] = [];
afterEach(async () => {
  for (const pid of managedPids.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 可能未创建进程组。 */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 命令已退出。 */ }
  }
  await fixture?.close();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
function bash(id: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name: 'Bash', arguments: JSON.stringify(input) } };
}
async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0], review?: Parameters<typeof startLocalOpenAIModel>[1], extra = {}) {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-bash-'));
  const { workspace, approval, ...settings } = extra as Record<string, unknown> & {
    workspace?: string; approval?: Record<string, unknown>;
  };
  workspaceArgs = workspace ? ['--workspace', workspace] : [];
  fixture = await startLocalOpenAIModel(respond, review);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'bash-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'TEST_BASH_KEY',
    timeoutMs: 4000, approval: { mode: 'auto', ...approval }, ...settings,
  }));
}
function run(input = '运行受控命令\n/exit\n', env: NodeJS.ProcessEnv = {}, conversationId = 'bash') {
  const child = spawn(process.execPath, [cli, '--conversation-id', conversationId, ...workspaceArgs], {
    cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_BASH_KEY: 'fake-bash-key', TEST_BASH_ENV: 'inherited-marker', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(input);
  return { child, done, output: () => stdout + stderr };
}
function results() {
  const messages = fixture.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
  return messages.map(({ tool_call_id, content }) => ({ id: tool_call_id, ...JSON.parse(content) })) as Array<{
    id: string; is_error: boolean; error?: { code: string; message: string };
    output?: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; truncated: boolean };
  }>;
}

it('Bash 默认独立审批，批准前无启动或副作用，批准后返回实际输出', async () => {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const command = 'printf private-command-output; printf private-error-output >&2; printf kept > kept.txt';
  await setup((_request, index) => index === 1 ? { calls: [bash('approved', { command })] } : { content: '命令完成' }, async () => {
    entered(); await gate; return { content: 'approve' };
  });
  const running = run();
  try {
    await Promise.race([waiting, running.done]);
    expect(fixture.approvalRequests).toHaveLength(1);
    expect(running.output()).not.toContain('Bash：开始');
    await expect(readFile(join(cwd, 'kept.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const review = fixture.approvalRequests[0]!;
    expect(review.tools ?? []).toEqual([]);
    expect(JSON.parse(review.messages[1]!.content)).toMatchObject({ toolName: 'Bash', input: { command } });
  } finally { release(); }
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(results()).toEqual([{ id: 'approved', is_error: false, output: {
    stdout: 'private-command-output', stderr: 'private-error-output', exitCode: 0, signal: null, truncated: false,
  } }]);
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept');
  expect(result.stdout + result.stderr).not.toMatch(/private-command-output|private-error-output|fake-bash-key/);
  expect(fixture.requests[0]!.messages[0]!.content).toContain('Bash');
  expect(fixture.requests[0]!.messages[0]!.content).not.toContain('没有执行命令');
  expect(fixture.requests[0]!.messages[0]!.content).toContain('不得声称操作成功或把失败调用的输出当成已验证结果');
});

it('允许命令仍为重定向审批，cwd 按工作区解析且独立 shell 不保留先前状态', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('first', { command: 'cd nested; export LOCAL_STATE=changed; printf first > first.txt' }),
    bash('default', { command: 'printf "%s|%s|%s" "$PWD" "${LOCAL_STATE-unset}" "$TEST_BASH_ENV"' }),
    bash('relative', { command: 'pwd', cwd: 'nested' }),
    bash('absolute', { command: 'pwd', cwd: join(cwd, 'work/nested') }),
  ] } : { content: '完成' }, () => ({ content: 'approve' }), {
    permissions: { allow: ['Bash(cd:*)', 'Bash(export:*)', 'Bash(printf:*)', 'Bash(pwd:*)'] },
    workspace: 'work',
  });
  await mkdir(join(cwd, 'work/nested'), { recursive: true });
  const running = run();
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(results().map(({ is_error }) => is_error)).toEqual([false, false, false, false]);
  expect(fixture.approvalRequests).toHaveLength(1);
  const canonical = await realpath(join(cwd, 'work'));
  expect(results()[1]!.output!.stdout).toBe(`${canonical}|unset|inherited-marker`);
  expect(results().slice(2).map(({ output }) => output!.stdout.trim())).toEqual([join(canonical, 'nested'), join(canonical, 'nested')]);
  expect(await readFile(join(cwd, 'work/nested/first.txt'), 'utf8')).toBe('first');
});

it('Bash 权限按完整命令和参数边界匹配，复合命令及命令替换逐条检查', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('exact', { command: 'printf exact' }),
    bash('exact-glob', { command: "printf '*.txt'" }),
    bash('prefix', { command: 'printf prefix value' }),
    bash('prefix-lookalike', { command: 'printf prefixish' }),
    bash('colon-denied', { command: 'touch blocked now' }),
    bash('compound', { command: 'printf before; touch denied-compound' }),
    bash('substitution', { command: 'printf "$(touch denied-substitution)"' }),
    bash('arithmetic-substitution', { command: 'echo $(( $(touch denied-arithmetic; echo 1) ))' }),
    bash('unparseable', { command: 'printf "$(touch missing-close"' }),
  ] } : { content: '权限完成' }, () => ({ content: 'approve' }), {
    permissions: {
      allow: ['Bash(printf exact)', "Bash(printf '*.txt')", 'Bash(printf prefix:*)'],
      deny: ['Bash(touch blocked:*)', 'Bash(touch denied-compound)', 'Bash(touch denied-substitution)', 'Bash(touch denied-arithmetic)'],
    },
  });
  const result = await run(undefined, {}, 'bash-permissions').done;
  expect(result.code, result.stderr).toBe(0);
  expect(fixture.requests.length, result.stdout + result.stderr).toBeGreaterThan(0);
  expect(results().map(({ is_error, error }) => ({ is_error, code: error?.code }))).toEqual([
    { is_error: false, code: undefined }, { is_error: false, code: undefined }, { is_error: false, code: undefined }, { is_error: false, code: undefined },
    { is_error: true, code: 'PERMISSION_DENIED' },
    { is_error: true, code: 'PERMISSION_DENIED' }, { is_error: true, code: 'PERMISSION_DENIED' },
    { is_error: true, code: 'PERMISSION_DENIED' }, { is_error: true, code: 'INVALID_TOOL_ARGUMENTS' },
  ]);
  expect(fixture.approvalRequests).toHaveLength(1);
  await expect(readFile(join(cwd, 'blocked'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'denied-compound'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'denied-substitution'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'denied-arithmetic'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('Bash 重定向和工作区外 cwd 必须审批，拒绝或未完成审批前不启动', async () => {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await setup((_request, index) => index === 1 ? { calls: [
    bash('redirect', { command: 'printf redirected > redirected.txt' }),
    bash('external', { command: 'pwd > external.txt', cwd: join(cwd, 'outside') }),
  ] } : { content: '审批完成' }, async (_request, index) => {
    if (index === 1) { entered(); await gate; }
    return { content: 'approve' };
  }, { workspace: 'work', permissions: { allow: ['Bash(printf:*)', 'Bash(pwd)'] } });
  await mkdir(join(cwd, 'work'));
  await mkdir(join(cwd, 'outside'));
  const running = run(undefined, {}, 'bash-external-cwd');
  try {
    await Promise.race([waiting, running.done]);
    expect(running.output()).not.toContain('Bash：开始');
    await expect(readFile(join(cwd, 'work/redirected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, 'outside/external.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); }
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(results().map(({ is_error }) => is_error)).toEqual([false, false]);
  expect(fixture.approvalRequests).toHaveLength(2);
  expect(await readFile(join(cwd, 'work/redirected.txt'), 'utf8')).toBe('redirected');
  expect((await readFile(join(cwd, 'outside/external.txt'), 'utf8')).trim()).toBe(await realpath(join(cwd, 'outside')));
});

it('Bash cwd 符号链接在审批期间改向后拒绝启动', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('retarget-cwd', { command: 'touch marker', cwd: 'link' }),
  ] } : { content: '目录变化已处理' }, async () => {
    await rm(join(cwd, 'work/link'));
    await symlink(join(cwd, 'outside/b'), join(cwd, 'work/link'));
    return { content: 'approve' };
  }, { workspace: 'work' });
  await mkdir(join(cwd, 'work'));
  await mkdir(join(cwd, 'outside/a'), { recursive: true });
  await mkdir(join(cwd, 'outside/b'), { recursive: true });
  await symlink(join(cwd, 'outside/a'), join(cwd, 'work/link'));

  const result = await run(undefined, {}, 'bash-retarget-cwd').done;

  expect(result.code, result.stderr).toBe(0);
  expect(results()).toMatchObject([{ is_error: true }]);
  await expect(readFile(join(cwd, 'outside/a/marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'outside/b/marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.approvalRequests).toHaveLength(1);
});

it('目录越界、符号链接逃逸、不可用目录及非法参数在审批前拒绝，后续调用继续', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    ...['missing', 'file'].map((directory, index) => bash(`cwd-${index}`, { command: 'touch must-not-start', cwd: directory })),
    bash('env', { command: 'touch must-not-start', env: { MODEL_ENV: 'forbidden' } }),
    bash('extra', { command: 'touch must-not-start', extra: true }),
    bash('missing-command', { cwd: '.' }), bash('wrong-command', { command: 42 }), bash('empty', { command: '  ' }),
    bash('valid', { command: 'printf valid' }),
  ] } : { content: '完成' }, () => ({ content: 'approve' }), { workspace: 'work' });
  await mkdir(join(cwd, 'work'));
  await mkdir(join(cwd, 'outside'));
  await symlink(join(cwd, 'outside'), join(cwd, 'work/escape'));
  await writeFile(join(cwd, 'work/file'), 'not-directory');
  const result = await run().done;
  expect(result.code, result.stderr).toBe(0);
  expect(results().slice(0, -1).map(({ error }) => error!.code)).toEqual(Array(7).fill('INVALID_TOOL_ARGUMENTS'));
  expect(results().at(-1)).toMatchObject({ id: 'valid', is_error: false, output: { stdout: 'valid' } });
  expect(fixture.approvalRequests).toHaveLength(1);
  await expect(readFile(join(cwd, 'must-not-start'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'outside/must-not-start'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('审批等待期间替换实际目录为外部链接时，批准也不能越界启动命令', async () => {
  await setup((_request, index) => index === 1 ? { calls: [bash('changed-cwd', { command: 'touch escaped.txt', cwd: 'nested' })] }
    : { content: '目录改变后停止该调用' }, async () => {
    await rename(join(cwd, 'work/nested'), join(cwd, 'work/previous'));
    await symlink(join(cwd, 'outside'), join(cwd, 'work/nested'));
    return { content: 'approve' };
  }, { workspace: 'work' });
  await mkdir(join(cwd, 'work/nested'), { recursive: true });
  await mkdir(join(cwd, 'outside'));
  const result = await run().done;
  expect(result.code, result.stderr).toBe(0);
  expect(results()[0]).toMatchObject({ id: 'changed-cwd', is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' } });
  await expect(readFile(join(cwd, 'outside/escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['fixed', 'model'] as const)('%s 拒绝 Bash 时没有命令副作用或开始事件', async (mode) => {
  await setup((_request, index) => index === 1 ? { calls: [bash('denied', { command: 'touch denied' }),
    { id: 'later', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
  ] } : { content: '拒绝后完成' }, () => ({ content: 'deny' }), mode === 'fixed' ? {
    permissions: { deny: ['Bash(touch:*)'] },
  } : {});
  const result = await run().done;
  expect(result.code).toBe(0);
  expect(results().map(({ id }) => id)).toEqual(['denied', 'later']);
  expect(results()[0]).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(results()[1]!.is_error).toBe(false);
  expect(result.stdout).not.toContain('Bash：开始');
  expect(fixture.approvalRequests).toHaveLength(mode === 'fixed' ? 0 : 1);
  await expect(readFile(join(cwd, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('非零退出作为单次失败回传实际状态与输出，同批后续命令继续', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('failed', { command: 'printf available; printf problem >&2; exit 7' }),
    bash('later', { command: 'printf continued > continued.txt' }),
  ] } : { content: '继续完成' });
  const result = await run().done;
  expect(result.code, result.stderr).toBe(0);
  expect(results()[0]).toMatchObject({ id: 'failed', is_error: true, error: { code: 'TOOL_EXECUTION_ERROR' },
    output: { exitCode: 7, stdout: 'available', stderr: 'problem', truncated: false } });
  expect(results()[1]!.is_error).toBe(false);
  expect(await readFile(join(cwd, 'continued.txt'), 'utf8')).toBe('continued');
  expect(result.stdout).toContain('Bash：失败');
});

it('Bash 失败后即使模型声称任务成功，也明确提示回复未获命令验证', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('failed-search', { command: 'exit 1' })] }
    : { content: '已找到微信的存放路径。' });
  const result = await run().done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('已找到微信的存放路径。');
  expect(result.stdout).toContain('本轮 Bash 命令执行失败，回复未获命令验证。');
});

it('stdout 与 stderr 合计限制为 64 KiB，超限继续消费并正确处理多字节文本', async () => {
  const script = "const fs = require('node:fs'); for (let i = 0; i < 128; i++) { fs.writeSync(1, '界'.repeat(4096)); fs.writeSync(2, '错误'.repeat(4096)); } fs.writeFileSync('drained.txt', 'done');";
  await setup((_request, index) => index === 1 ? { calls: [bash('large', { command: `${process.execPath} -e ${JSON.stringify(script)}` })] } : { content: '完成' });
  const result = await run().done;
  expect(result.code, result.stderr).toBe(0);
  expect(results()[0]).toMatchObject({ is_error: false, output: { exitCode: 0, truncated: true } });
  const output = results()[0]!.output!;
  const bytes = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
  expect(bytes).toBeLessThanOrEqual(65_536);
  expect(bytes).toBeGreaterThanOrEqual(65_530);
  expect(output.stdout + output.stderr).not.toContain('�');
  expect(await readFile(join(cwd, 'drained.txt'), 'utf8')).toBe('done');
});

it.each(['SIGINT', 'SIGTERM'] as const)('%s 取消终止命令及子进程，保留已有副作用且不启动后续调用', async (stop) => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('running', { command: `echo $$ > shell.pid; ${process.execPath} worker.cjs & wait` }),
    bash('later', { command: 'touch later.txt' }),
  ] } : { content: '不应请求后续模型' });
  await writeFile(join(cwd, 'worker.cjs'), "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); fs.writeFileSync('kept.txt', 'kept'); setTimeout(() => fs.writeFileSync('late.txt', 'leaked'), 1500); setInterval(() => {}, 1000);");
  const running = run();
  let workerPid = 0;
  await expect.poll(async () => {
    workerPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8').catch(() => '0'));
    return workerPid > 0;
  }, { timeout: 3000, interval: 20 }).toBe(true);
  const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
  managedPids.push(shellPid, workerPid);
  running.child.kill(stop);
  const result = await running.done;
  expect(result.code, result.stderr).toBe(stop === 'SIGINT' ? 0 : 130);
  expect(isRunning(shellPid)).toBe(false);
  expect(isRunning(workerPid)).toBe(false);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.approvalRequests).toHaveLength(1);
  expect(result.stdout + result.stderr).toContain(stop === 'SIGINT' ? 'Interrupt by user' : 'CANCELLED');
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  for (const path of ['late.txt', 'later.txt', '.agent/conversations/bash.json']) {
    await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

function isRunning(pid: number): boolean {
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return status !== '' && !status.startsWith('Z');
}

it.each(['command', 'turn'] as const)('%s 超时终止进程树：单命令失败可继续，整轮停止无后续操作', async (limit) => {
  await setup((_request, index) => index === 1 ? { calls: [
    bash('timeout', { command: `echo $$ > shell.pid; ${process.execPath} worker.cjs & wait` }),
    bash('later', { command: 'printf later > later.txt' }),
  ] } : { content: '超时后继续完成' }, undefined, {
    timeoutMs: limit === 'turn' ? 600 : 4000,
    bash: { timeoutMs: limit === 'command' ? 350 : 3000 },
  });
  await writeFile(join(cwd, 'worker.cjs'), "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('child.pid', String(process.pid)); fs.writeFileSync('kept.txt', 'kept'); setTimeout(() => fs.writeFileSync('late.txt', 'leaked'), 1500); setInterval(() => {}, 1000);");
  const running = run();
  let workerPid = 0;
  await expect.poll(async () => {
    workerPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8').catch(() => '0'));
    return workerPid > 0;
  }, { timeout: 3000, interval: 20 }).toBe(true);
  const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
  managedPids.push(shellPid, workerPid);
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(isRunning(shellPid)).toBe(false);
  expect(isRunning(workerPid)).toBe(false);
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept');
  if (limit === 'command') {
    expect(results()[0]).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR', message: expect.stringContaining('超时') }, output: { exitCode: null, signal: 'SIGKILL' } });
    expect(results()[1]!.is_error).toBe(false);
    expect(await readFile(join(cwd, 'later.txt'), 'utf8')).toBe('later');
  } else {
    expect(result.stderr).toContain('TIMEOUT');
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.approvalRequests).toHaveLength(1);
    for (const path of ['later.txt', '.agent/conversations/bash.json']) {
      await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await expect(readFile(join(cwd, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('Bash 不可启动时只反馈安全的调用失败，同批其他工具仍可使用', async () => {
  await setup((_request, index) => index === 1 ? { calls: [bash('unavailable', { command: 'printf private-start-failure' }),
    { id: 'later', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
  ] } : { content: '仍可完成' });
  await mkdir(join(cwd, 'empty-bin'));
  const result = await run(undefined, { PATH: join(cwd, 'empty-bin') }).done;
  expect(result.code, result.stderr).toBe(0);
  expect(results()[0]).toMatchObject({ is_error: true, error: { code: 'TOOL_EXECUTION_ERROR', message: '无法启动 Bash 命令。' } });
  expect(results()[1]).toMatchObject({ id: 'later', is_error: false });
  expect(result.stdout + result.stderr).not.toMatch(/ENOENT|private-start-failure/);
});

it.each([
  null, 1, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: '100' },
  { timeoutMs: 3_600_001 }, { extra: true },
])('非法 Bash 配置在请求前拒绝：%j', async (bash) => {
  await setup(() => ({ content: '不应请求' }), undefined, { bash });
  const result = await run().done;
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('CONFIG_ERROR');
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.approvalRequests).toHaveLength(0);
});
