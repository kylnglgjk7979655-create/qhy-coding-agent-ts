import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalQA } from './helpers/local-qa-fixture.js';

const cli = resolve('dist/cli.js');
const children: ReturnType<typeof spawn>[] = [];
let cwd = '';
let qa: Awaited<ReturnType<typeof startLocalQA>>;
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await qa?.close();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
async function setup(scenario: Parameters<typeof startLocalQA>[0] = 'normal') {
  cwd = await mkdtemp(join(tmpdir(), 'qhy-capabilities-'));
  qa = await startLocalQA(scenario);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent/settings.json'), JSON.stringify(qa.config));
}
function run(input?: string) {
  const child = spawn(process.execPath, [cli, '--conversation-id', 'combined'], {
    cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TEST_MODEL_API_KEY: 'fake-qa-model', QA_MCP_HEADER: 'fake-qa-header' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  if (input !== undefined) child.stdin.end(input);
  return { child, done, output: () => stdout + stderr };
}

it('混合批次按顺序回传各类失败和调用 ID，先写后读及命令副作用对后续工具可见', async () => {
  await setup();
  const result = await run('mixed\n/exit\n').done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('夹具完成：mixed');
  const messages = qa.model.requests.at(-1)!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ tool_call_id: string; content: string }>;
  expect(messages.map(({ tool_call_id }) => tool_call_id)).toEqual([
    'invalid', 'unknown', 'denied', 'write', 'read', 'bash-failure', 'remote-failure', 'bash-write', 'bash-read', 'remote-ok', 'tail',
  ]);
  const results = messages.map(({ content }) => JSON.parse(content));
  expect(results.map((result) => result.error?.code ?? 'success')).toEqual([
    'INVALID_TOOL_ARGUMENTS', 'UNKNOWN_TOOL', 'PERMISSION_DENIED', 'success', 'success',
    'TOOL_EXECUTION_ERROR', 'TOOL_EXECUTION_ERROR', 'success', 'success', 'success', 'success',
  ]);
  expect(results[4]).toMatchObject({ output: { content: 'private-file-content' } });
  expect(results[5]).toMatchObject({ output: { exitCode: 7, stdout: 'private-command-output' } });
  expect(results[8]).toMatchObject({ output: { content: 'kept-bash' } });
  expect(qa.alpha.calls).toEqual([{ name: 'echo', arguments: { text: 'fail' } }]);
  expect(qa.beta.calls).toEqual([{ name: 'echo', arguments: { text: 'private-remote-content' } }]);
  expect(qa.model.approvalRequests.map((request) => JSON.parse(request.messages[1]!.content).toolName)).toEqual([
    'write_file', 'write_file', 'Bash', 'mcp_alpha_echo', 'Bash', 'mcp_beta_echo',
  ]);
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('private-file-content');
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const history = await readFile(join(cwd, '.agent/conversations/combined.json'), 'utf8');
  expect(JSON.stringify(qa.model.requests) + JSON.stringify(qa.model.approvalRequests) + history).not.toContain('fake-qa-header');
  expect(qa.alpha.requests.every(({ headers }) => headers.authorization === 'fake-qa-header')).toBe(true);
  expect(result.stdout + result.stderr).not.toMatch(/private-file-content|private-command-output|private-remote-content|fake-qa-header|fake-qa-model|远端声明失败/);
  const events = result.stdout.match(/\[工具\] [^\r\n]+/g)!;
  expect(events.slice(0, 7)).toEqual([
    '[工具] write_file：拒绝', '[工具] missing_tool：拒绝', '[工具] write_file：拒绝',
    '[工具] write_file：开始', '[工具] write_file：成功', '[工具] read_file：开始', '[工具] read_file：成功',
  ]);
});


it.each(['approval-error', 'approval-invalid', 'approval-timeout'] as const)('文件和远端副作用后 %s 停止混合批次，成功历史不变且同进程可继续', async (scenario) => {
  await setup(scenario);
  expect((await run('baseline\n/exit\n').done).stdout).toContain('夹具回复：baseline');
  const historyPath = join(cwd, '.agent/conversations/combined.json');
  const previous = await readFile(historyPath, 'utf8');
  const running = run();
  running.child.stdin.write('fault\n');
  await expect.poll(running.output, { timeout: 5000 }).toContain('APPROVAL_ERROR');
  expect(await readFile(historyPath, 'utf8')).toBe(previous);
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept-file');
  expect(qa.alpha.calls).toEqual([{ name: 'echo', arguments: { text: 'kept-remote' } }]);
  for (const path of ['blocked.txt', 'later.txt']) {
    await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(qa.model.requests).toHaveLength(2);
  expect(qa.model.approvalRequests).toHaveLength(3);
  expect(running.output()).not.toContain('Bash：开始');
  expect(running.output()).not.toMatch(/private-review-error|fake-qa-header|fake-qa-model/);
  running.child.stdin.end('recover\n/exit\n');
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('夹具回复：recover');
  expect(JSON.stringify(qa.model.requests.at(-1))).not.toMatch(/blocked.txt|kept-remote|"fault"/);
  expect(await readFile(historyPath, 'utf8')).not.toContain('fault');
});


it.each(['summary-error', 'summary-invalid'] as const)('混合副作用与工具增长触发 %s，停止后不保存且同进程恢复沿用成功历史', async (scenario) => {
  await setup(scenario);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent/settings.json'), JSON.stringify({ ...qa.config,
    context: { capacityTokens: 19_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
  const directory = join(cwd, '.agent/conversations');
  await mkdir(directory, { recursive: true });
  const historyPath = join(directory, 'combined.json');
  const previous = JSON.stringify([{ role: 'user', content: '旧目标' }, { role: 'assistant', content: '原文标记' + '旧'.repeat(3000) }]);
  await writeFile(historyPath, previous);
  await writeFile(join(cwd, 'large.txt'), 'private-large-content' + '新'.repeat(1800));
  const running = run();
  running.child.stdin.write('growth\n');
  await expect.poll(running.output, { timeout: 5000 }).toContain('CONTEXT_ERROR');
  expect(qa.model.requests).toHaveLength(1);
  expect(qa.model.summaryRequests).toHaveLength(1);
  expect(await readFile(join(cwd, 'kept.txt'), 'utf8')).toBe('kept-file');
  expect(qa.alpha.calls).toEqual([{ name: 'echo', arguments: { text: 'kept-remote' } }]);
  expect(await readFile(historyPath, 'utf8')).toBe(previous);
  expect(running.output()).not.toMatch(/private-large-content|private-summary-error|fake-qa-header/);
  running.child.stdin.end('recover\n/exit\n');
  expect((await running.done).stdout).toContain('夹具回复：recover');
  expect(qa.model.requests).toHaveLength(2);
  expect(JSON.stringify(qa.model.requests.at(-1))).not.toMatch(/kept-remote|private-large-content|"growth"/);
});

it('混合工具增长后整体摘要，工具往返进入摘要且跨进程续聊', async () => {
  await setup();
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent/settings.json'), JSON.stringify({ ...qa.config,
    context: { capacityTokens: 19_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
  await mkdir(join(cwd, '.agent/conversations'), { recursive: true });
  const historyPath = join(cwd, '.agent/conversations/combined.json');
  await writeFile(historyPath, JSON.stringify([{ role: 'user', content: '旧目标' }, { role: 'assistant', content: '原文标记' + '旧'.repeat(3000) }]));
  await writeFile(join(cwd, 'large.txt'), '新'.repeat(1800));
  const result = await run('growth\n/exit\n').done;
  expect(result.stdout).toContain('夹具完成：压缩后继续');
  expect(qa.model.summaryRequests).toHaveLength(1);
  // 全部有效历史进入摘要，包含当前轮已完成的工具调用与结果。
  const summarized = JSON.parse(qa.model.summaryRequests[0]!.messages[1]!.content) as Array<{ role: string; content: unknown }>;
  expect(JSON.stringify(summarized)).toContain('原文标记');
  expect(JSON.stringify(summarized)).toContain('growth-read');
  expect(JSON.stringify(summarized)).toContain('新新新');
  const request = qa.model.requests[1]!;
  expect(JSON.stringify(request)).toContain('[对话摘要]');
  expect(JSON.stringify(request)).not.toContain('原文标记');
  expect(request.messages.filter(({ role }) => role === 'tool')).toEqual([]);
  const saved = await readFile(historyPath, 'utf8');
  expect(saved).toContain('[对话摘要]');
  expect(saved).not.toContain('原文标记');
  expect((await run('recover\n/exit\n').done).stdout).toContain('夹具回复：recover');
  expect(JSON.stringify(qa.model.requests.at(-1))).toContain('[对话摘要]');
  expect(JSON.stringify(qa.model.requests.at(-1))).not.toContain('原文标记');
});

it.each([
  ['pairing', 'PROVIDER_ERROR'], ['oversized', 'CONTEXT_ERROR'],
] as const)('%s 停止后没有实际操作或后续模型请求，仍可继续新消息', async (command, code) => {
  await setup();
  // 超过摘要请求输入预算的工具结果无法压缩，按既有停止条件终止本轮。
  await writeFile(join(cwd, 'huge.txt'), '超'.repeat(40_000));
  await run('baseline\n/exit\n').done;
  const historyPath = join(cwd, '.agent/conversations/combined.json');
  const previous = await readFile(historyPath, 'utf8');
  const running = run();
  running.child.stdin.write(command + '\n');
  await expect.poll(running.output, { timeout: 5000 }).toContain(code);
  expect(qa.model.requests).toHaveLength(2);
  expect(qa.model.approvalRequests).toHaveLength(0);
  expect(qa.alpha.calls).toEqual([]);
  expect(qa.beta.calls).toEqual([]);
  expect(await readFile(historyPath, 'utf8')).toBe(previous);
  for (const path of ['pairing.txt', 'later.txt']) {
    await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  running.child.stdin.end('recover\n/exit\n');
  expect((await running.done).stdout).toContain('夹具回复：recover');
  expect(await readFile(historyPath, 'utf8')).not.toContain(command);
});
