import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';

const cli = resolve('dist/cli.js');
let cwd = '';
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  if (cwd) {
    const pid = await readFile(join(cwd, 'cli.pid'), 'utf8').catch(() => '');
    if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* CLI 已退出。 */ } }
  }
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await fixture?.close();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
function write(id: string, path = 'note.txt'): FixtureToolCall {
  return { id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: `内容-${id}` }) } };
}
async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0], extra = {}) {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-human-approval-'));
  fixture = await startLocalOpenAIModel(respond, () => { throw new Error('人工模式不得请求模型审批'); });
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'human-fixture', apiKeyEnv: 'TEST_HUMAN_KEY', baseURL: fixture.baseURL,
    timeoutMs: 3000, approval: { mode: 'default', humanTimeoutMs: 2000 }, ...extra,
  }));
}
function run(terminal = true) {
  const cliArgs = [cli, '--conversation-id', 'human'];
  const command = ['/bin/sh', '-c', 'echo $$ > cli.pid; exec "$@"', 'human-cli', process.execPath, ...cliArgs];
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', '/dev/null', ...command]
    : ['-q', '-e', '-c', command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' '), '/dev/null'];
  const child = terminal
    ? spawn('/bin/sh', ['-c', 'cat | script "$@"', 'human-test', ...scriptArgs], {
      cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_HUMAN_KEY: 'fake-human-key' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    : spawn(process.execPath, cliArgs, {
      cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_HUMAN_KEY: 'fake-human-key' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const waiters = new Set<() => void>();
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); for (const notify of waiters) notify(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); for (const notify of waiters) notify(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return {
    child, done, output: () => stdout + stderr,
    waitFor: async (text: string) => {
      if ((stdout + stderr).includes(text)) return;
      let notify!: () => void;
      const arrived = new Promise<void>((resolve) => {
        notify = () => { if ((stdout + stderr).includes(text)) resolve(); };
        waiters.add(notify);
      });
      try {
        await Promise.race([arrived, done.then((result) => { throw new Error(`等待 ${text} 前进程退出 ${result.code}：${stdout}${stderr}`); })]);
      } finally { waiters.delete(notify); }
    },
  };
}
function results() {
  return fixture.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
}

it.skipIf(process.platform === 'win32')('人工审批 Bash 展示完整参数与实际 cwd，等待不启动命令且不扣整轮预算', async () => {
  const command = 'printf approved > approved.txt';
  await setup((_request, index) => index === 1 ? { calls: [
    { id: 'bash-approve', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command, cwd: 'alias' }) } },
    { id: 'bash-deny', type: 'function', function: { name: 'Bash', arguments: '{"command":"touch denied.txt"}' } },
    { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"nested/approved.txt"}' } },
  ] } : { content: 'Bash 审批完成' }, { timeoutMs: 600 });
  await mkdir(join(cwd, 'nested'));
  await symlink(join(cwd, 'nested'), join(cwd, 'alias'));
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('执行命令\n');
  await running.waitFor('approve 1');
  expect(running.output()).toContain(command);
  expect(running.output()).toContain('"cwd": "alias"');
  expect(running.output()).toContain(`实际工作目录：${await realpath(join(cwd, 'nested'))}`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(running.output()).not.toContain('Bash：开始');
  await expect(readFile(join(cwd, 'nested/approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  running.child.stdin.write('approve 1\n');
  await running.waitFor('approve 2');
  expect(await readFile(join(cwd, 'nested/approved.txt'), 'utf8')).toBe('approved');
  expect(running.output()).toContain(`实际工作目录：${await realpath(cwd)}`);
  running.child.stdin.write('deny 2\n');
  await running.waitFor('Bash 审批完成');
  running.child.stdin.end('/exit\n');
  const result = await running.done;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(results().map(({ tool_call_id }) => tool_call_id)).toEqual(['bash-approve', 'bash-deny', 'read']);
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([false, true, false]);
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('人工批准后写入工作区外目标并展示规范实际路径', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'qhy-human-write-outside-'));
  try {
    const target = join(outside, 'approved.txt');
    await setup((_request, index) => index === 1
      ? { calls: [write('outside', 'outside-link/approved.txt')] }
      : { content: '外部写入完成。' });
    await symlink(outside, join(cwd, 'outside-link'));
    const running = run();
    running.child.stdin.write('写入获批的外部目标\n');
    await running.waitFor('[人工审批 1] write_file');
    expect(running.output()).toContain('"path": "outside-link/approved.txt"');
    expect(running.output()).toContain(`实际文件目标：${target}`);
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    running.child.stdin.write('approve 1\n');
    await running.waitFor('外部写入完成。');
    running.child.stdin.end('/exit\n');

    const result = await running.done;
    expect(result.code).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('内容-outside');
    expect(results().map(({ tool_call_id }) => tool_call_id)).toContain('outside');
    expect(fixture.requests).toHaveLength(2);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('并发人工审批按各自编号独立处理', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    { id: 'parallel-read-one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one.txt"}' } },
    { id: 'parallel-read-two', type: 'function', function: { name: 'read_file', arguments: '{"path":"two.txt"}' } },
  ] } : { content: '两项读取均已批准' }, {
    approval: { mode: 'default', rules: [{ toolName: 'read_file', action: 'ask' }], humanTimeoutMs: 2000 },
  });
  await writeFile(join(cwd, 'one.txt'), 'one');
  await writeFile(join(cwd, 'two.txt'), 'two');
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('读取两个文件\n');
  await running.waitFor('approve 1');
  await running.waitFor('approve 2');

  running.child.stdin.write('approve 2\n');
  running.child.stdin.write('approve 1\n');
  await running.waitFor('两项读取均已批准');
  running.child.stdin.end('/exit\n');

  const result = await running.done;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(results().map(({ tool_call_id }) => tool_call_id).sort()).toEqual(['parallel-read-one', 'parallel-read-two']);
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([false, false]);
});

it('非交互管道直接拒绝人工审批，后续需求不被当作答复且仍能完成', async () => {
  await setup((_request, index) => index === 1 ? { calls: [write('pipe')] } : { content: '继续完成' });
  const running = run(false);
  running.child.stdin.end('请求写入\n下一条需求\n/exit\n');
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('write_file：拒绝');
  expect(result.stdout).not.toContain('write_file：开始');
  expect(JSON.parse(fixture.requests[1]!.messages.find(({ role }) => role === 'tool')!.content))
    .toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  expect(fixture.requests[2]!.messages.at(-1)!.content).toBe('下一条需求');
  expect(fixture.approvalRequests).toHaveLength(0);
  await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('人工逐次展示完整参数，只有当前编号答复有效，拒绝后继续同批调用', async () => {
  await setup((_request, index) => index === 1 ? { calls: [write('first'), write('second', 'other.txt'),
    { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
  ] } : { content: '本轮完成' });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('开始写入\n');
  await running.waitFor('approve 1');
  expect(running.output()).toContain('write_file');
  expect(running.output()).toContain('内容-first');
  expect(running.output()).toContain('note.txt');
  expect(running.output()).not.toContain('write_file：开始');
  await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  running.child.stdin.write('下一条用户需求\n');
  await running.waitFor('答复无效');
  expect(running.output()).not.toContain('write_file：开始');
  running.child.stdin.write('approve 1\n');
  await running.waitFor('approve 2');
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('内容-first');
  running.child.stdin.write('approve 1\n'); // 迟到答复不能批准另一次调用。
  await running.waitFor('答复无效，请输入 approve 2 或 deny 2');
  running.child.stdin.write('deny 2\n');
  await running.waitFor('本轮完成');
  running.child.stdin.end('/exit\n');
  const result = await running.done;
  expect(result.code).toBe(0);
  const logs = result.stdout.split(/\r?\n/).filter((line) => line.includes('"event":')).join('\n');
  expect(logs).not.toContain('内容-first');
  expect(logs).not.toContain('内容-second');
  expect(logs).not.toContain('fake-human-key');
  const history = await readFile(join(cwd, '.agent/conversations/human.json'), 'utf8');
  expect(history).not.toContain('approve 1');
  expect(history).not.toContain('下一条用户需求');
  await expect(readFile(join(cwd, 'other.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(results().map(({ tool_call_id }) => tool_call_id)).toEqual(['first', 'second', 'read']);
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([false, true, false]);
  expect(fixture.approvalRequests).toHaveLength(0);
});

it.skipIf(process.platform === 'win32')('人工等待超时只拒绝当前调用，迟到答复不能批准下一个调用', async () => {
  await setup((_request, index) => index === 1 ? { calls: [write('expired'), write('next', 'next.txt')] } : { content: '超时后完成' }, {
    approval: { mode: 'default', humanTimeoutMs: 250 },
  });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('超时审批\n');
  await running.waitFor('approve 2');
  expect(running.output()).toContain('write_file：拒绝');
  expect(running.output()).not.toContain('write_file：开始');
  running.child.stdin.write('approve 1\n');
  await running.waitFor('答复无效，请输入 approve 2');
  running.child.stdin.write('approve 2\n');
  await running.waitFor('超时后完成');
  running.child.stdin.end('/exit\n');
  const result = await running.done;
  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('APPROVAL_ERROR');
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([true, false]);
  await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(cwd, 'next.txt'), 'utf8')).toBe('内容-next');
});

it.skipIf(process.platform === 'win32')('审批中关闭终端输入会直接拒绝当前和后续待审批调用', async () => {
  await setup((_request, index) => index === 1 ? { calls: [write('allowed', 'allowed.txt'), write('closed')] } : { content: '关闭后完成' }, {
    approval: { mode: 'default', rules: [{ toolName: 'runtimeInfo', action: 'deny' }] },
  });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('输入关闭\n');
  await running.waitFor('approve 1');
  // 真实终端空行上的 Ctrl+D 触发 readline 的输入关闭。
  running.child.stdin.write('\x04');
  await running.waitFor('关闭后完成');
  running.child.stdin.end();
  expect((await running.done).code, running.output()).toBe(0);
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([true, true]);
  expect(running.output()).not.toContain('write_file：开始');
});

it.skipIf(process.platform === 'win32').each(['Ctrl+C', 'SIGTERM'] as const)('人工等待可被 %s 立即取消，不启动当前或后续操作且不保存', async (stop) => {
  await setup(() => ({ calls: [write('cancel'), { id: 'later', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } }] }));
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('取消审批\n');
  await running.waitFor('approve 1');
  if (stop === 'Ctrl+C') running.child.stdin.end('\x03');
  else {
    process.kill(Number(await readFile(join(cwd, 'cli.pid'), 'utf8')), 'SIGTERM');
    running.child.stdin.end();
  }
  const result = await running.done;
  expect(result.code, running.output()).toBe(stop === 'Ctrl+C' ? 0 : 130);
  expect(running.output()).toContain(stop === 'Ctrl+C' ? 'Interrupt by user' : 'CANCELLED');
  expect(running.output()).not.toContain('：开始');
  expect(fixture.requests).toHaveLength(1);
  await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, '.agent/conversations/human.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('多次人工等待不会重置此前模型处理已消耗的整轮预算，超时后可继续下一轮', async () => {
  await setup(async (_request, index) => {
    if (index > 3) return { content: '恢复完成' };
    await new Promise((resolve) => setTimeout(resolve, 350));
    return index < 3 ? { calls: [write(`step-${index}`, `step-${index}.txt`)] } : { content: '不应完成' };
  }, { timeoutMs: 1000 });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('累计预算\n');
  for (const number of [1, 2]) {
    await running.waitFor(`approve ${number}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    running.child.stdin.write(`approve ${number}\n`);
  }
  await running.waitFor('TIMEOUT');
  expect(running.output()).not.toContain('不应完成');
  expect(fixture.requests).toHaveLength(3);
  expect(await readFile(join(cwd, 'step-1.txt'), 'utf8')).toBe('内容-step-1');
  expect(await readFile(join(cwd, 'step-2.txt'), 'utf8')).toBe('内容-step-2');
  await expect(readFile(join(cwd, '.agent/conversations/human.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  running.child.stdin.write('恢复输入\n');
  await running.waitFor('恢复完成');
  running.child.stdin.end('/exit\n');
  expect((await running.done).code).toBe(0);
  const history = await readFile(join(cwd, '.agent/conversations/human.json'), 'utf8');
  expect(history).toContain('恢复输入');
  expect(history).not.toContain('累计预算');
});

it.skipIf(process.platform === 'win32')('人工思考跨过整轮截止时间仍可逐次批准，且人工上限独立于模型审批上限', async () => {
  await setup((_request, index) => index === 1 ? { calls: [write('one'), write('two', 'two.txt')] } : { content: '等待后完成' }, {
    timeoutMs: 500, approval: { mode: 'default', timeoutMs: 50, humanTimeoutMs: 2000 },
  });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('两次批准\n');
  await running.waitFor('approve 1');
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(running.output()).not.toContain('TIMEOUT');
  running.child.stdin.write('approve 1\n');
  await running.waitFor('approve 2');
  await new Promise((resolve) => setTimeout(resolve, 650));
  running.child.stdin.write('approve 2\n');
  await running.waitFor('等待后完成');
  running.child.stdin.end('/exit\n');
  expect((await running.done).code).toBe(0);
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('内容-one');
  expect(await readFile(join(cwd, 'two.txt'), 'utf8')).toBe('内容-two');
  expect(fixture.approvalRequests).toHaveLength(0);
});

it.skipIf(process.platform === 'win32')('默认人工等待上限为五分钟，固定允许及冲突拒绝不等待人工答复', async () => {
  await setup((_request, index) => index === 1 ? { calls: [
    write('allowed'), { id: 'denied', type: 'function', function: { name: 'runtimeInfo', arguments: '{}' } },
    { id: 'asked', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } },
  ] } : { content: '策略完成' }, {
    approval: { mode: 'default', rules: [
      { toolName: 'write_file', action: 'allow' },
      { toolName: 'runtimeInfo', action: 'allow' }, { toolName: 'runtimeInfo', action: 'deny' },
      { toolName: 'read_file', action: 'ask' },
    ] },
  });
  const running = run();
  await running.waitFor('> ');
  running.child.stdin.write('检查策略\n');
  await running.waitFor('approve 1');
  expect(running.output()).toContain('最多等待 300000ms');
  expect(running.output()).toContain('[人工审批 1] read_file');
  expect(running.output()).toContain('runtimeInfo：拒绝');
  expect(running.output()).not.toContain('runtimeInfo：开始');
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('内容-allowed');
  running.child.stdin.write('deny 1\n');
  await running.waitFor('策略完成');
  running.child.stdin.end('/exit\n');
  expect((await running.done).code).toBe(0);
  expect(results().map(({ content }) => JSON.parse(content).is_error)).toEqual([false, true, true]);
  expect(fixture.approvalRequests).toHaveLength(0);
});

it.each([0, -1, '100', 1.5, 3_600_001, null])('非法人工等待上限 %j 在请求或工具操作前报错', async (humanTimeoutMs) => {
  await setup(() => ({ calls: [write('invalid')] }), { approval: { mode: 'default', humanTimeoutMs } });
  const running = run(false);
  running.child.stdin.end('不应运行\n');
  const result = await running.done;
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('CONFIG_ERROR');
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.approvalRequests).toHaveLength(0);
});


it.skipIf(process.platform === 'win32').each(['整轮超时', 'SIGTERM'] as const)(
  '人工等待跨过原截止时间后启动 Bash，%s 仍终止进程树且不执行后续调用', async (stop) => {
    await setup((_request, index) => index === 1 ? { calls: [
      write('kept', 'kept.txt'),
      { id: 'running', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `echo $$ > shell.pid; ${process.execPath} worker.cjs & wait` }) } },
      write('later', 'later.txt'),
    ] } : { content: '不应再次请求主模型' }, {
      timeoutMs: 1000, bash: { timeoutMs: 5000 },
      approval: { mode: 'default', humanTimeoutMs: 3000, rules: [{ toolName: 'write_file', action: 'allow' }] },
    });
    await writeFile(join(cwd, 'worker.cjs'), "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); setTimeout(() => fs.writeFileSync('late.txt', 'leaked'), 1800); setInterval(() => {}, 1000);");
    const running = run();
    let shellPid = 0, workerPid = 0;
    try {
      await running.waitFor('> ');
      running.child.stdin.write('人工等待后运行命令\n');
      await running.waitFor('approve 1');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(running.output()).not.toContain('TIMEOUT');
      expect(running.output()).not.toContain('Bash：开始');
      expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('内容-kept');
      await expect(readFile(join(cwd, 'shell.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
      running.child.stdin.write('approve 1\n');
      await expect.poll(async () => Number(await readFile(join(cwd, 'child.pid'), 'utf8').catch(() => '0')), { timeout: 2000 }).toBeGreaterThan(0);
      shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8'));
      workerPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
      if (stop === 'SIGTERM') {
        process.kill(Number(await readFile(join(cwd, 'cli.pid'), 'utf8')), 'SIGTERM');
        running.child.stdin.end();
      } else {
        await running.waitFor('TIMEOUT');
        running.child.stdin.end('/exit\n');
      }
      const result = await running.done;
      expect(result.code, result.stdout + result.stderr).toBe(stop === 'SIGTERM' ? 130 : 0);
      expect(result.stdout + result.stderr).toContain(stop === 'SIGTERM' ? 'CANCELLED' : 'TIMEOUT');
      for (const pid of [shellPid, workerPid]) {
        const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        expect(status === '' || status.startsWith('Z')).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 1900));
      for (const path of ['late.txt', 'later.txt', '.agent/conversations/human.json']) {
        await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.approvalRequests).toHaveLength(0);
    } finally {
      if (!shellPid) shellPid = Number(await readFile(join(cwd, 'shell.pid'), 'utf8').catch(() => '0'));
      if (shellPid) { try { process.kill(-shellPid, 'SIGKILL'); } catch { /* 进程组已退出。 */ } }
    }
  },
);
