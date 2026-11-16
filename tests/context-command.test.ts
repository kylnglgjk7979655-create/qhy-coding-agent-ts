import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const secret = 'context-command-test-key';
const summary = '目标：上下文用量验收；约束：保留有效历史；关键结果：压缩已完成；未完成事项：无。';
const roots: string[] = [];
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

async function setup(respond: Parameters<typeof startLocalOpenAIModel>[0], context: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-context-command-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-context-command-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(respond, undefined, () => ({ content: summary }));
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'auto' },
    // 容量足够大，隔离自动压缩与手动压缩；使用非默认容量验证展示来源。
    context: { capacityTokens: 64_000, answerReserveTokens: 700, maxOutputTokens: 1_000, ...context },
  }));
  return { cwd, userDir, model };
}

interface UsageReport {
  estimated: number;
  capacity: number;
  ratio: number;
}

const usagePattern = /上下文用量（估算）：约 ([\d,]+) \/ ([\d,]+) tokens（([\d.]+)%）/gu;

function usageReports(output: string): UsageReport[] {
  return [...output.matchAll(usagePattern)].map((match) => ({
    estimated: Number(match[1]!.replaceAll(',', '')),
    capacity: Number(match[2]!.replaceAll(',', '')),
    ratio: Number(match[3]),
  }));
}

it('帮助中列出 /context 命令', async () => {
  const { cwd } = await setup(() => ({ content: '未使用' }));
  const result = await startCLI({ cwd, args: ['--help'], env: { TEST_MODEL_API_KEY: secret } }).done;

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('/context');
});

it('空对话执行 /context 展示估算用量与配置容量，不发起模型请求', async () => {
  const { cwd, userDir, model } = await setup(() => ({ content: '未使用' }));
  const result = await startCLI({ cwd, userDir, input: '/context\n/exit\n', env: { TEST_MODEL_API_KEY: secret } }).done;

  expect(result.code).toBe(0);
  const reports = usageReports(result.stdout);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.estimated).toBeGreaterThan(0);
  expect(reports[0]!.capacity).toBe(64_000);
  expect(reports[0]!.ratio).toBeCloseTo(Number(((reports[0]!.estimated / 64_000) * 100).toFixed(1)), 5);
  expect(result.stdout).toContain('估算');
  expect(result.stdout).toContain('不发起模型请求');
  expect(model.requests).toHaveLength(0);
  expect(model.summaryRequests).toHaveLength(0);
});

it('消息增加后 /context 按当前有效历史更新，且命令不进入对话', async () => {
  const { cwd, userDir, model } = await setup(() => ({ content: '第一轮回答。' }));
  let output = '';
  const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 1, () => `输出=${output}`);
  cli.send('第一轮需求\n');
  await waitFor(() => model.requests.length === 1 && output.includes('第一轮回答。'), () => `请求数=${model.requests.length}，输出=${output}`);
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 2, () => `输出=${output}`);
  cli.send('第二轮需求\n');
  await waitFor(() => model.requests.length === 2, () => `请求数=${model.requests.length}，输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;

  expect(result.code).toBe(0);
  const [before, after] = usageReports(output);
  expect(after!.estimated).toBeGreaterThan(before!.estimated);
  expect(after!.capacity).toBe(before!.capacity);
  expect(after!.ratio).toBeGreaterThan(before!.ratio);
  expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('/context');
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('第一轮需求');
});

it('压缩改变有效历史后 /context 显示压缩后的估算值，且不增加主模型请求', async () => {
  const longAnswer = '长回答内容。'.repeat(1_000);
  const { cwd, userDir, model } = await setup(() => ({ content: longAnswer }));
  let output = '';
  const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('压缩前需求_MARKER\n');
  await waitFor(() => model.requests.length === 1 && output.includes('长回答内容。'), () => `请求数=${model.requests.length}`);
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 1, () => `输出=${output}`);
  cli.send('/compact\n');
  await waitFor(() => output.includes('已压缩当前会话历史'), () => `输出=${output}`);
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 2, () => `输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;

  expect(result.code).toBe(0);
  expect(model.requests).toHaveLength(1);
  expect(model.summaryRequests).toHaveLength(1);
  const [before, after] = usageReports(output);
  expect(after!.estimated).toBeLessThan(before!.estimated);
  expect(after!.capacity).toBe(before!.capacity);
});

it('自动压缩改变有效历史后 /context 显示压缩后的估算值，且不增加主模型请求', async () => {
  // 容量 70k、最大输出 20k 时自动压缩阈值为 37k；约 4 万中文字的估算输入会触发压缩，摘要输入仍在 50k 预算内。
  const longAnswer = '长回答内容。'.repeat(6_667);
  const { cwd, userDir, model } = await setup(
    (_request, index) => ({ content: index === 1 ? longAnswer : '压缩后回答。' }),
    { capacityTokens: 70_000, maxOutputTokens: 20_000 },
  );
  let output = '';
  const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('压缩前需求_MARKER\n');
  await waitFor(() => model.requests.length === 1 && output.includes('长回答内容。'), () => `请求数=${model.requests.length}`);
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 1, () => `输出=${output.slice(0, 200)}`);
  cli.send('压缩后需求\n');
  await waitFor(() => model.requests.length === 2 && model.summaryRequests.length === 1 && output.includes('压缩后回答。'), () => `主请求数=${model.requests.length}，摘要请求数=${model.summaryRequests.length}`);
  cli.send('/context\n');
  await waitFor(() => usageReports(output).length === 2, () => `输出=${output.slice(0, 200)}`);
  cli.end('/exit\n');
  const result = await cli.done;

  expect(result.code).toBe(0);
  expect(model.requests).toHaveLength(2);
  expect(model.summaryRequests).toHaveLength(1);
  expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('压缩前需求_MARKER');
  expect(JSON.stringify(model.requests[1]!.messages)).not.toContain(longAnswer);
  const [before, after] = usageReports(output);
  expect(after!.estimated).toBeLessThan(before!.estimated);
  expect(after!.capacity).toBe(70_000);
});
