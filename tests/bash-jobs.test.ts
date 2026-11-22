import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
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
    // 每次工具调用只交付一个结果；切换到后台不额外补造第二条。
    expect(fixture.requests[1]!.messages.filter(({ role }) => role === 'tool')).toHaveLength(1);
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

it.skipIf(process.platform === 'win32')('接回前台后 Ctrl+C 停止作业并回到空闲输入', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('ctrl-c-stop', {
      // 标记拆成相邻引号，避免与工具活动里回显的命令文本混淆。
      command: `echo $$ > shell.pid; printf '%s\\n' 'ATTACHED''_MARKER'; sleep 30`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' });

  const cli = startCLI({
    cwd,
    conversationId: 'bash-ctrl-c',
    pty: true,
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key' },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台长命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `后台命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 接回前台`), `未接回前台：${output}`);
    await waitFor(() => output.includes('ATTACHED_MARKER'), `接回后未显示保留输出：${output}`);
    cli.send('\u0003');
    await waitFor(() => output.includes(`已停止 Bash 作业：${taskId}`), `Ctrl+C 未停止接回的作业：${output}`);
    await waitFor(() => !isRunning(shellPid), '停止后作业进程仍在运行。', 3000);

    // 停止后终端回到空闲命令处理；列表保留终态与输出。
    cli.send('/tasks\n');
    await waitFor(() => output.includes(`- ${taskId} [cancelled]`), `未回到空闲输入：${output}`);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('后台运行不计入前台时限，接回后继续使用剩余预算', async () => {
  const timeoutMs = 2400;
  await setup((_request, index) => index === 1
    ? { calls: [bash('budget', {
      command: `echo $$ > shell.pid; sleep 10`,
    })] }
    : { content: '前台命令已切换。' }, { bash: { timeoutMs } });

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
    // 前台先用掉约一半时限，再切到后台。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    cli.send('\u0002');
    await waitFor(() => output.includes('已切换到后台：任务 '), `Ctrl+B 未切换作业：${output}`);

    // 在后台停留的时间超过完整前台时限；进程必须仍在运行。
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 200));
    expect(isRunning(shellPid)).toBe(true);

    await waitFor(() => fixture.requests.length >= 2, `模型未收到任务 ID：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    const resumedAt = Date.now();
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：timed_out`), `接回后未继续使用剩余时限：${output}`, 4000);
    // 已用约 1.2s，剩余约 1.2s；若接回后重新获得完整时限，耗时会接近 timeoutMs。
    const elapsed = Date.now() - resumedAt;
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(timeoutMs - 500);
    await waitFor(() => !isRunning(shellPid), '前台时限用尽后进程仍在运行。', 3000);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('直接在后台启动的作业首次接回获得完整前台时限', async () => {
  const timeoutMs = 1200;
  await setup((_request, index) => index === 1
    ? { calls: [bash('background-budget', {
      command: `echo $$ > shell.pid; sleep 10`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' }, { bash: { timeoutMs } });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台长命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `后台命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);
    // 后台已运行超过完整前台时限；接回时必须重新获得完整预算，而不是立即超时。
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 300));
    expect(isRunning(shellPid)).toBe(true);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes('接回前台'), `未接回前台：${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output).not.toContain(`[Bash 作业 ${taskId}] 已结束：timed_out`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：timed_out`), `首次接回未获得完整时限：${output}`, 3000);
    await waitFor(() => !isRunning(shellPid), '前台时限用尽后进程仍在运行。', 3000);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('CLI 正常退出时终止仍在运行的后台作业与受管子进程', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('exit-cleanup', {
      command: `echo $$ > shell.pid; sleep 30`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动常驻后台命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `后台命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);
    expect(isRunning(shellPid)).toBe(true);

    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
    await waitFor(() => !isRunning(shellPid), 'CLI 退出后后台作业仍在运行。', 3000);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('启动交接前取消不启动后台命令，也不留下无任务 ID 的作业', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('aborted-launch', {
      command: 'printf launched > started.txt; sleep 30',
      run_in_background: true,
    })] }
    : { content: '不应请求后续模型' });

  const pause = join(cwd, 'pause-stats');
  const ready = join(cwd, 'stat-paused');
  const release = join(cwd, 'stat-resume');
  const preload = join(cwd, 'pause-bash-stat.mjs');
  // 延迟 execute 阶段的 cwd 检查，并在第二次检查（startPlannedBash 内部）暂停，
  // 制造“轮次已取消、进程尚未 spawn”的窗口；只作用于 CLI 子进程。
  await writeFile(preload, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { setTimeout } from 'node:timers/promises';
    const io = createRequire(import.meta.url)('node:fs/promises');
    const stat = io.stat;
    let checks = 0;
    io.stat = async (path, ...rest) => {
      if (String(path) === ${JSON.stringify(cwd)}) {
        await setTimeout(300);
        if (existsSync(${JSON.stringify(pause)})) {
          checks += 1;
          if (checks >= 2) {
            writeFileSync(${JSON.stringify(ready)}, '', { flag: 'wx' });
            while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
          }
        }
      }
      return stat(path, ...rest);
    };
    syncBuiltinESMExports();
  `);

  const cli = startCLI({
    cwd,
    conversationId: 'bash-aborted-launch',
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台命令\n');
    // prepare 先于审批完成；审批请求出现后开启暂停，随后 execute 的 cwd 检查会停在这里。
    await waitFor(() => fixture.approvalRequests.length >= 1, `未进入审批：${output}`);
    await writeFile(pause, '');
    await waitFor(() => existsSync(ready), `未停在启动前的 cwd 检查：${output}`);
    cli.child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(release, '');

    // 回到空闲输入后确认没有可接回的作业，也没有执行过命令。
    cli.send('/tasks\n');
    await waitFor(() => output.includes('当前会话没有 Bash 作业'), `取消后仍存在作业：${output}`);
    expect(fixture.requests).toHaveLength(1);
    await expect(readFile(join(cwd, 'started.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('启动回执延迟期间取消会终止自有进程组，且不留下无任务 ID 的作业', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('receipt-cancel', {
      command: `echo $$ > shell.pid; printf launched > started.txt; sleep 30`,
      run_in_background: true,
    })] }
    : { content: '不应请求后续模型' });

  const spawned = join(cwd, 'spawned.pid');
  const preload = join(cwd, 'delay-spawn.mjs');
  // 子进程已经创建但 'spawn' 回执尚未送达工具层；真实环境里这个窗口很窄，这里放大到 500ms。
  await writeFile(preload, `
    import { createRequire } from 'node:module';
    import { appendFileSync } from 'node:fs';
    const cp = createRequire(import.meta.url)('node:child_process');
    const proto = cp.ChildProcess.prototype;
    const emit = proto.emit;
    proto.emit = function (name, ...args) {
      if (name === 'spawn' && this.spawnfile === 'bash') {
        appendFileSync(${JSON.stringify(spawned)}, String(this.pid) + '\\n');
        const self = this;
        setTimeout(() => emit.call(self, name, ...args), 500);
        return true;
      }
      return emit.call(this, name, ...args);
    };
  `);

  const cli = startCLI({
    cwd,
    conversationId: 'bash-receipt-cancel',
    pty: true,
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台命令\n');
    await waitFor(() => existsSync(spawned), `未进入 spawn 回执窗口：${output}`);
    const shellPid = Number((await readFile(spawned, 'utf8')).trim().split('\n')[0]);
    managedPids.push(shellPid);
    cli.send('\u0003');
    await waitFor(() => output.includes('Interrupt by user'), `取消后未显示用户中断：${output}`);
    // 等待回执延迟结束：延迟到达的 started 不能复活已取消的作业。
    await new Promise((resolve) => setTimeout(resolve, 900));
    cli.send('/tasks\n');
    await waitFor(() => output.includes('当前会话没有 Bash 作业'), `取消后仍存在可领取作业：${output}`);
    expect(fixture.requests).toHaveLength(1);
    expect(isRunning(shellPid)).toBe(false);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

// 需要真实网络代理拒绝：仅 macOS Seatbelt 会把命令放进沙箱并走代理。
it.skipIf(process.platform !== 'darwin')('沙箱在接回期间结束时，首次 /task 就显示结构化拒绝诊断', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('sandbox-violation', {
      command: `curl -sS --max-time 5 https://denied.example/; printf 'AFTER_CURL\\n'; sleep 2`,
      run_in_background: true,
    })] }
    : { content: '作业已启动。' }, {
    permissions: { sandbox: { enabled: true, onUnavailable: 'open', networkAllow: ['allowed.example'], networkPorts: [443] } },
  });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动受限网络命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 接回前台`), `未接回前台：${output}`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束`), `作业未在接回期间结束：${output}`);
    const attachStart = output.indexOf(`[Bash 作业 ${taskId}] 接回前台`);
    const region = output.slice(attachStart);
    // 代理诊断只随终态产生；首次接回必须交付，不能等到第二次 /task 才显示。
    expect(region).toContain('<sandbox_violations>');
    expect(region).toContain('host-not-allowed');
    // 终态诊断不能重放整份输出：命令自身的最近/实时输出仍只出现一次。
    expect(region.split('AFTER_CURL').length - 1).toBe(1);
    expect(region.split('<sandbox_violations>').length - 1).toBe(1);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('外层命令结束后回收同进程组残留子进程', async () => {
  const worker = `const fs = require('node:fs'); fs.writeFileSync('grandchild.pid', String(process.pid)); setInterval(() => {}, 1000);`;
  await setup((_request, index) => index === 1
    ? { calls: [bash('group-reap', {
      command: `echo $$ > shell.pid; ${process.execPath} -e ${JSON.stringify(worker)} >/dev/null 2>&1 & `
        + `sleep 0.5; printf 'parent-done\\n'`,
      run_in_background: true,
    })] }
    : { content: '作业已结束。' });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动带残留子进程的作业\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const reaped = toolOutput(fixture.requests[1]!);
    expect(reaped.is_error, JSON.stringify(reaped)).toBe(false);
    const taskId = String(reaped.output!.taskId);
    await waitFor(() => existsSync(join(cwd, 'grandchild.pid')), `子进程未启动：${output}`);
    const grandchildPid = Number(await readFile(join(cwd, 'grandchild.pid'), 'utf8'));
    managedPids.push(grandchildPid);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);

    // 外层 shell 已退出且关闭 stdio；同 PGID 的子进程必须在作业收尾时被回收。
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：succeeded`), `未显示终态：${output}`);
    expect(output).toContain('parent-done');
    await waitFor(() => !isRunning(grandchildPid), '同进程组的残留子进程仍在运行。', 3000);
    expect(isRunning(shellPid)).toBe(false);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('输出超过 64 KiB 后 /task 仍显示最近内容与明确的截断提示', async () => {
  const producer = `const fs = require('node:fs'); const line = 'x'.repeat(1023) + '\\n'; `
    + `for (let i = 0; i < 80; i++) fs.writeSync(1, line); fs.writeSync(1, 'RECENT_MARKER\\n'); setInterval(() => {}, 1000);`;
  await setup((_request, index) => index === 1
    ? { calls: [bash('recent-output', {
      command: `${process.execPath} -e ${JSON.stringify(producer)}`,
      run_in_background: true,
    })] }
    : { content: '作业已启动。' });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动大量输出的后台命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    // 等待超过 64 KiB 的输出全部写入后再接回；早先内容已从最近窗口丢弃。
    await new Promise((resolve) => setTimeout(resolve, 500));
    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes('接回前台'), `未接回前台：${output}`);
    await waitFor(() => output.includes('超过保留上限'), `未提示最近输出被截断：${output}`);
    await waitFor(() => output.includes('RECENT_MARKER'), `未显示最近输出：${output}`);

    // 接回后在空闲前停止作业，确认状态回到 cancelled 并保留终态。
    cli.child.kill('SIGINT');
    await waitFor(() => output.includes(`已停止 Bash 作业：${taskId}`), `未停止作业：${output}`);
    cli.send('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('后台启动结果与首次接回都保留沙箱状态和说明', async () => {
  // 豁免获准（macOS Seatbelt）或沙箱不可用时都会给出 notice；两种情况都应在后台结果中出现。
  await setup((_request, index) => index === 1
    ? { calls: [bash('sandbox-notice', {
      command: `printf 'SANDBOX_MARKER\\n'; sleep 1.2`,
      disableSandbox: true,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' }, {
    permissions: { sandbox: { enabled: true, onUnavailable: 'open', bypassAllowedCommands: ['printf:*', 'sleep:*'] } },
  });

  const cli = run();
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动沙箱外命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const started = toolOutput(fixture.requests[1]!).output!;
    expect(started).toMatchObject({ status: 'running', sandboxed: false });
    const visibleNotice = String(started.notice);
    expect(visibleNotice).toMatch(/豁免获准|未隔离/u);
    const taskId = String(started.taskId);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes('接回前台'), `未接回前台：${output}`);
    // 首次接回运行中作业时也要显示同一份沙箱状态说明。
    await waitFor(() => output.includes(visibleNotice), `接回时丢失沙箱说明：${output}`);
    await waitFor(() => output.includes('SANDBOX_MARKER'), `未显示命令输出：${output}`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 已结束：succeeded`), `未显示终态：${output}`);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('接回前台时再次按 Ctrl+B 只提示一次切换', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('detach-attached', {
      command: `echo $$ > shell.pid; sleep 30`,
      run_in_background: true,
    })] }
    : { content: '后台作业已启动。' });

  const cli = startCLI({
    cwd,
    conversationId: 'bash-detach-attached',
    pty: true,
    env: { TEST_BASH_JOBS_KEY: 'fake-bash-jobs-key' },
  });
  let output = '';
  cli.child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    cli.send('启动后台长命令\n');
    await waitFor(() => fixture.requests.length >= 2, `模型未收到后台工具结果：${output}`);
    const taskId = String(toolOutput(fixture.requests[1]!).output!.taskId);
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `后台命令未启动：${output}`);
    const shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
    managedPids.push(shellPid);

    cli.send(`/task ${taskId}\n`);
    await waitFor(() => output.includes(`[Bash 作业 ${taskId}] 接回前台`), `未接回前台：${output}`);
    cli.send('\u0002');
    await waitFor(() => output.includes(`已切换到后台：任务 ${taskId}`), `Ctrl+B 未切换：${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const switches = output.split(`已切换到后台：任务 ${taskId}`).length - 1;
    expect(switches, `切换提示重复出现：${output}`).toBe(1);
    expect(isRunning(shellPid)).toBe(true);

    cli.send(`/tasks stop ${taskId}\n`);
    await waitFor(() => output.includes(`已停止 Bash 作业：${taskId}`), `未停止作业：${output}`);
    await waitFor(() => !isRunning(shellPid), '停止后作业仍在运行。', 3000);
    cli.end('/exit\n');
    expect((await cli.done).code).toBe(0);
  } finally {
    cli.child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('子 Agent 的提示与 Bash 工具定义不宣称后台作业能力', async () => {
  await setup((_request, index) => index === 1
    ? { calls: [bash('subagent-bash', { command: 'printf subagent-ok' })] }
    : { content: '子任务完成。' });
  const config: ResolvedConfig = {
    approval: { mode: 'default', rules: [], timeoutMs: 30_000, humanTimeoutMs: 30_000 },
    permissions: { allow: [], ask: [], deny: [], sandbox: { ...DEFAULT_SANDBOX, enabled: false } },
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    baseURL: fixture.baseURL, workspace: cwd, timeoutMs: 5000, maxSteps: 4,
  };
  const result = await runAgent(config, '执行子任务', {
    smokeTool: false,
    generalPurposeSubagent: true,
    approvalControl: async () => 'approve',
  });

  const request = fixture.requests[0]!;
  const bashTool = request.tools.find(({ function: definition }) => definition.name === 'Bash');
  expect(bashTool).toBeDefined();
  expect(JSON.stringify(bashTool!.function.parameters)).not.toContain('run_in_background');
  const instructions = request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
  expect(instructions).not.toContain('run_in_background');
  expect(result.text).toBeTruthy();
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
    await waitFor(() => existsSync(join(cwd, 'shell.pid')), `后台命令未启动：${output}`);
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
