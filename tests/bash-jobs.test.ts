import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall, FixtureRequest } from './helpers/local-openai-fixture.js';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

let cwd = '';
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

async function setup(
  respond: Parameters<typeof startLocalOpenAIModel>[0],
  settings: Record<string, unknown> = {},
): Promise<void> {
  cwd = await tempDir('qhy-bash-jobs-');
  fixture = await startLocalOpenAIModel(respond);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'bash-jobs-fixture', baseURL: fixture.baseURL, apiKeyEnv: 'TEST_BASH_JOBS_KEY',
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'auto' }, ...settings,
  }));
}

function run() {
  return startCLI({
    cwd,
    conversationId: 'bash-jobs',
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key' },
  });
}

function toolOutput(request: FixtureRequest): { is_error: boolean; output?: Record<string, unknown> } {
  const message = request.messages.find(({ role }) => role === 'tool') as unknown as { content: string } | undefined;
  if (!message) throw new Error('缺少工具结果消息。');
  return JSON.parse(message.content) as { is_error: boolean; output?: Record<string, unknown> };
}

async function waitFor(check: () => boolean, message: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isRunning(pid: number): boolean {
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return status !== '' && !status.startsWith('Z');
}

it.skipIf(process.platform === 'win32')('run_in_background 立即返回任务 ID，/tasks 与 /task 读取同一进程的保留与后续输出', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('background', {
      command: `printf 'first-output\\n'; printf 'launched\\n' >> started.log; sleep 1.5; printf 'second-output\\n'`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台命令\n');
    // 第一轮结束后才进入空闲命令处理；后台作业此时仍在运行。
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const launched = toolOutput(fixture.requests[1]!);
    expect(launched.is_error).toBe(false);
    expect(launched.output).toMatchObject({ status: 'running' });
    const taskId = String(launched.output!.taskId);
    expect(taskId).toMatch(/[0-9a-f-]{36}/u);

    cli.send('/tasks\n');
    await waitFor(() => output.includes(`- ${taskId} [running]`), `列表未显示运行中的作业：${output}`);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes('接回前台'), `未接回前台：${output}`);
    await waitFor(() => output.includes('second-output'), `未继续显示后续输出：${output}`);
    await waitFor(() => output.includes('[Bash 作业') && output.includes('已结束：succeeded'), `未报告结束状态：${output}`);

    expect(output).toContain('first-output');
    expect(output).toContain('second-output');
    expect((await readFile(join(cwd, 'started.log'), 'utf8')).trim().split('\n')).toEqual(['launched']);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('Ctrl+B 把前台进程切到后台，接回后仍是同一个进程', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('foreground', {
      command: `echo $$ > shell.pid; printf 'foreground-start\\n'; printf 'launched\\n' >> started.log; sleep 1.2; printf 'foreground-end\\n'`,
    })] }
    : { content: '前台命令已处理。' });

  const cli = startCLI({
    cwd,
    conversationId: 'bash-detach',
    pty: true,
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key' },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('运行前台命令\n');
    await waitFor(() => existsSync(join(cwd, 'started.log')), `命令未启动：${output}`);
    // 前台作业运行期间按 Ctrl+B；进程应继续运行，而不是被终止或重新启动。
    cli.send('\u0002');
    await waitFor(() => output.includes('已切换到后台：任务 '), `Ctrl+B 未切换作业：${output}`);
    await waitFor(() => fixture.requests.length >= 2, `模型未收到任务 ID：${output}`);
    const detached = toolOutput(fixture.requests[1]!);
    expect(detached.output).toMatchObject({ status: 'running', detached: true });
    const taskId = String(detached.output!.taskId);

    await waitFor(() => output.includes('前台命令已处理。'), `首轮未结束：${output}`);
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes('foreground-start'), `接回后未显示保留输出：${output}`);
    await waitFor(() => output.includes('foreground-end'), `接回后未显示实时输出：${output}`);
    await waitFor(() => output.includes('已结束：succeeded'), `未报告结束状态：${output}`);

    expect((await readFile(join(cwd, 'started.log'), 'utf8')).trim().split('\n')).toEqual(['launched']);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);
    expect(isRunning(shellPid)).toBe(false);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('后台运行不计入前台时限，接回后继续使用剩余预算', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('budget', {
      command: `echo $$ > shell.pid; sleep 10`,
    })] }
    : { content: '前台命令已切换。' }, { bash: { timeoutMs: 1500 } });

  const cli = startCLI({
    cwd,
    conversationId: 'bash-budget',
    pty: true,
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key' },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('运行长命令\n');
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);
    await new Promise((resolve) => setTimeout(resolve, 400));
    cli.send('\u0002');
    await waitFor(() => output.includes('已切换到后台：任务 '), `Ctrl+B 未切换作业：${output}`);

    // 在后台停留的时间超过完整前台时限；进程必须仍在运行。
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(isRunning(shellPid)).toBe(true);

    await waitFor(() => fixture.requests.length >= 2, `模型未收到任务 ID：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    const resumedAt = Date.now();
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：timed_out`), `接回后未继续使用剩余时限：${output}`, 5000);
    // 已用约 400ms，剩余约 1.1s；接回后不应重新获得完整时限。
    expect(Date.now() - resumedAt).toBeLessThan(4000);
    await waitFor(() => !isRunning(shellPid), '前台时限用尽后进程仍在运行。', 3000);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('/tasks stop 终止后台作业并保留可读取的终态输出', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('background-stop', {
      command: `echo $$ > shell.pid; printf 'before-stop\\n'; sleep 5; printf 'after-stop\\n'`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动可停止命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    await waitFor(() => {
      try { return require('node:fs').existsSync(join(cwd, 'shell.pid')); } catch { return false; }
    }, `后台命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);

    cli.send(`/tasks stop ${taskId}\n`);
    await waitFor(() => output.includes(`已停止 Bash 作业：${taskId}`), `未停止作业：${output}`);
    await waitFor(() => !isRunning(shellPid), '作业进程仍在运行。', 3000);
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：cancelled，退出码`), `未显示取消终态：${output}`);
    expect(output).toContain('before-stop');
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});