import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const secret = 'file-recovery-test-key';
const summary = '目标：压缩后恢复最近读取文件；约束：保留最近顺序；结果：候选开头已附加；未完成事项：人工 QA。';
let roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 CLI 状态超时：${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readCall(file: string, id: string) {
  return { id, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } };
}

async function setup(
  files: Record<string, string>,
  respond: Parameters<typeof startLocalOpenAIModel>[0],
  extra: Record<string, unknown> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-recover-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-recover-user-'));
  roots.push(cwd, userDir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cwd, name), content);
  }
  const model = await startLocalOpenAIModel(respond, undefined, () => ({ content: summary }));
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'auto' },
    // 容量足够大，隔离自动阈值，统一用 /compact 触发压缩。
    context: { capacityTokens: 100_000, answerReserveTokens: 700, maxOutputTokens: 1_000 },
    ...extra,
  }));
  return { cwd, userDir, model };
}

function recordPath(userDir: string): string {
  return join(userDir, '.qhy-coding-agents', 'sessions', 'recover', 'record.json');
}

interface SavedRecord {
  effectiveHistory: Array<{ role: string; content: unknown }>;
  recentFiles: string[];
}

async function readRecord(userDir: string): Promise<SavedRecord> {
  return JSON.parse(await readFile(recordPath(userDir), 'utf8')) as SavedRecord;
}

function recoveryContent(record: SavedRecord): string | undefined {
  const message = record.effectiveHistory.find((item) => typeof item.content === 'string' && item.content.includes('[文件恢复资料]'));
  if (typeof message?.content !== 'string') return undefined;
  // 恢复资料作为摘要包装内的独立段落，从标记处截取到消息末尾。
  return message.content.slice(message.content.indexOf('[文件恢复资料]'));
}

function fileSection(recovery: string, file: string): string | undefined {
  const marker = `## ${file}\n`;
  const start = recovery.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length;
  const next = recovery.indexOf('\n## ', from);
  return recovery.slice(from, next < 0 ? undefined : next);
}

it('成功读取按最近优先去重记录顺序，失败读取不进入记录', async () => {
  const { cwd, userDir, model } = await setup(
    { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' },
    (_request, index) => {
      // 第三步故意读取不存在的文件，验证失败读取不进入记录。
      const order = ['a.txt', 'b.txt', 'missing.txt', 'c.txt', 'a.txt'];
      if (index <= order.length) return { calls: [readCall(order[index - 1]!, `read-${index}`)] };
      return { content: '完成' };
    },
  );
  const cli = startCLI({ cwd, userDir, conversationId: 'recover', input: '读取文件\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await cli.done).code).toBe(0);
  expect(model.requests.length).toBe(6);
  // 读取 a、b、缺失、c、a 后：最近优先去重为 a、c、b；失败的 missing 不进入记录。
  expect((await readRecord(userDir)).recentFiles).toEqual([
    join(cwd, 'a.txt'), join(cwd, 'c.txt'), join(cwd, 'b.txt'),
  ]);
});

it('最近读取记录跨进程续聊保留', async () => {
  const { cwd, userDir, model } = await setup(
    { 'a.txt': 'AAA', 'b.txt': 'BBB', 'c.txt': 'CCC' },
    (_request, index) => {
      if (index === 1) return { calls: [readCall('a.txt', 'first-a')] };
      if (index === 2) return { calls: [readCall('b.txt', 'first-b')] };
      if (index === 4) return { calls: [readCall('c.txt', 'second-c')] };
      return { content: '完成' };
    },
  );
  const first = startCLI({ cwd, userDir, conversationId: 'recover', input: '第一轮读取\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await first.done).code).toBe(0);
  expect((await readRecord(userDir)).recentFiles).toEqual([join(cwd, 'b.txt'), join(cwd, 'a.txt')]);

  const second = startCLI({ cwd, userDir, conversationId: 'recover', input: '第二轮读取\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await second.done).code).toBe(0);
  expect(model.summaryRequests).toHaveLength(0);
  expect((await readRecord(userDir)).recentFiles).toEqual([
    join(cwd, 'c.txt'), join(cwd, 'b.txt'), join(cwd, 'a.txt'),
  ]);
});

it('压缩恢复读取磁盘最新内容而非读取时的旧内容', async () => {
  const { cwd, userDir } = await setup(
    { 'a.txt': '版本一_MARKER' },
    (_request, index) => index === 1 ? { calls: [readCall('a.txt', 'read-a')] } : { content: '完成' },
  );
  const first = startCLI({ cwd, userDir, conversationId: 'recover', input: '读取文件\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await first.done).code).toBe(0);

  await writeFile(join(cwd, 'a.txt'), '版本二_MARKER');
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'recover', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('/compact\n');
  await waitFor(() => output.includes('已压缩当前会话历史'), () => `输出=${output}`);
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);

  const recovery = recoveryContent(await readRecord(userDir));
  expect(recovery).toContain('## a.txt');
  expect(recovery).toContain('版本二_MARKER');
  expect(recovery).not.toContain('版本一_MARKER');
});

it('候选缺失或不可读时跳过且不补位，恢复读取不刷新顺序', async () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  const files: Record<string, string> = {};
  for (const name of order) files[`${name}.txt`] = `FILE_${name.toUpperCase()}_MARKER`;
  const { cwd, userDir } = await setup(
    files,
    (_request, index) => index <= order.length
      ? { calls: [readCall(`${order[index - 1]}.txt`, `read-${index}`)] }
      : { content: '完成' },
  );
  const first = startCLI({ cwd, userDir, conversationId: 'recover', input: '读取六个文件\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await first.done).code).toBe(0);
  const newestFirst = [...order].reverse().map((name) => join(cwd, `${name}.txt`));
  expect((await readRecord(userDir)).recentFiles).toEqual(newestFirst);

  // 删除第 3 个候选 c；它属于最近五个，恢复时跳过且不补位到第六个 a。
  await rm(join(cwd, 'c.txt'));
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'recover', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('/compact\n');
  await waitFor(() => output.includes('已压缩当前会话历史'), () => `输出=${output}`);
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);

  const recovery = recoveryContent(await readRecord(userDir));
  expect(recovery).toBeDefined();
  for (const name of ['f', 'e', 'd', 'b']) expect(recovery).toContain(`FILE_${name.toUpperCase()}_MARKER`);
  expect(recovery).not.toContain('FILE_C_MARKER');
  expect(recovery).not.toContain('FILE_A_MARKER');
  // 恢复读取不刷新顺序，记录仍保持最近优先的六项。
  expect((await readRecord(userDir)).recentFiles).toEqual(newestFirst);
});

it('单个文件只恢复开头约 5,000 token，按码点裁剪保留有效编码', async () => {
  const original = 'x'.repeat(20_000);
  const { cwd, userDir } = await setup(
    { 'big.txt': original },
    (_request, index) => index === 1 ? { calls: [readCall('big.txt', 'read-big')] } : { content: '完成' },
  );
  const first = startCLI({ cwd, userDir, conversationId: 'recover', input: '读取大文件\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await first.done).code).toBe(0);

  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'recover', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('/compact\n');
  await waitFor(() => output.includes('已压缩当前会话历史'), () => `输出=${output}`);
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);

  const recovery = recoveryContent(await readRecord(userDir));
  const section = recovery ? fileSection(recovery, 'big.txt') : undefined;
  expect(section).toBeDefined();
  const [opening, marker] = section!.split('\n…（内容已截断）');
  // 20,000 字节约 6,667 token；裁剪到 5,000 token 约 15,000 字符，且是原文前缀。
  expect(opening!.length).toBe(15_000);
  expect(original.startsWith(opening!)).toBe(true);
  expect(marker).toBe('');
});

it('工作区外文件即使曾被读取，恢复时按边界约束跳过', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-recover-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-recover-user-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'qhy-recover-outside-'));
  roots.push(cwd, userDir, outsideDir);
  const outside = join(outsideDir, 'outside-secret.txt');
  await writeFile(outside, 'OUTSIDE_SECRET_MARKER');
  const model = await startLocalOpenAIModel(
    (_request, index) => index === 1 ? { calls: [readCall(outside, 'read-outside')] } : { content: '完成' },
    undefined,
    () => ({ content: summary }),
  );
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'auto' },
    permissions: { allow: ['Read'] },
    context: { capacityTokens: 100_000, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));

  const first = startCLI({ cwd, userDir, conversationId: 'recover', input: '读取工作区外文件\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await first.done).code).toBe(0);
  // 读取成功，进入最近记录（规范绝对路径在工作区外）。
  expect((await readRecord(userDir)).recentFiles.length).toBe(1);

  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'recover', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('/compact\n');
  await waitFor(() => output.includes('已压缩当前会话历史'), () => `输出=${output}`);
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);

  // 恢复读取遵守工作区边界：工作区外候选跳过，不进入恢复资料。
  const recovery = recoveryContent(await readRecord(userDir));
  expect(recovery ?? '').not.toContain('OUTSIDE_SECRET_MARKER');
});