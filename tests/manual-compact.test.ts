import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const secret = 'manual-compact-test-key';
const summary = '目标：手动压缩验收；约束：保留完整原文；关键结果：空闲与执行中均已压缩；未完成事项：人工 QA。';
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

async function setup(
  respond: Parameters<typeof startLocalOpenAIModel>[0],
  summarize: Parameters<typeof startLocalOpenAIModel>[2] = () => ({ content: summary }),
  extra: Record<string, unknown> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-manual-compact-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-manual-compact-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(respond, undefined, summarize);
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 5000, maxSteps: 10, approval: { mode: 'auto' },
    permissions: { allow: ['Bash(node:*)'] },
    // 容量足够大，隔离手动压缩与自动阈值。
    context: { capacityTokens: 100_000, answerReserveTokens: 700, maxOutputTokens: 1_000 },
    ...extra,
  }));
  return { cwd, userDir, model };
}

function recordPath(userDir: string): string {
  return join(userDir, '.qhy-coding-agents', 'sessions', 'compact', 'record.json');
}

interface SavedRecord {
  transcript: unknown[];
  effectiveHistory: unknown[];
  summaries: Array<{ text: string; coversThrough: number }>;
}

async function readRecord(userDir: string): Promise<SavedRecord> {
  return JSON.parse(await readFile(recordPath(userDir), 'utf8')) as SavedRecord;
}

async function waitRecord(userDir: string, predicate: (record: SavedRecord) => boolean, describe: () => string): Promise<SavedRecord> {
  const deadline = Date.now() + 5000;
  while (true) {
    const record = await readRecord(userDir);
    if (predicate(record)) return record;
    if (Date.now() >= deadline) throw new Error(`等待会话记录超时：${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function summarizedMessages(fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>>): string {
  return fixture.summaryRequests[0]!.messages[1]!.content;
}

it('空闲时 /compact 压缩并保存当前有效历史，随后返回输入且不请求主模型', async () => {
  const { cwd, userDir, model } = await setup(() => ({ content: '空闲答复' }));
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'compact', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('空闲需求_MARKER\n');
  await waitFor(() => model.requests.length === 1 && output.includes('空闲答复'), () => `请求数=${model.requests.length}，输出=${output}`);

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 1 && output.includes('已压缩当前会话历史'), () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;
  expect(result.code).toBe(0);

  // 手动压缩只发起摘要请求，不额外续做任务。
  expect(model.requests).toHaveLength(1);
  expect(summarizedMessages(model)).toContain('空闲需求_MARKER');
  const record = await readRecord(userDir);
  expect(record.summaries).toEqual([{ text: summary, coversThrough: 2 }]);
  expect(JSON.stringify(record.effectiveHistory)).toContain('[对话摘要]');
  expect(JSON.stringify(record.effectiveHistory)).toContain(summary);
  expect(JSON.stringify(record.effectiveHistory)).not.toContain('空闲需求_MARKER');
  // 完整 transcript 保留原文，供后续按需回看。
  expect(JSON.stringify(record.transcript)).toContain('空闲需求_MARKER');

  // 重启后直接续用压缩历史，不重放被摘要覆盖的原文。
  const resumed = startCLI({ cwd, userDir, conversationId: 'compact', input: '重启后续聊\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await resumed.done).code).toBe(0);
  expect(model.summaryRequests).toHaveLength(1);
  const resumedRequest = model.requests.at(-1)!;
  expect(JSON.stringify(resumedRequest)).toContain(summary);
  expect(JSON.stringify(resumedRequest)).not.toContain('空闲需求_MARKER');
  expect(JSON.stringify(resumedRequest)).toContain('重启后续聊');
});

it('执行中输入 /compact 会等待工具结果写入，再于同轮下一次主模型请求前压缩并继续任务', async () => {
  const { cwd, userDir, model } = await setup((_request, index) => index === 1
    ? { calls: [{ id: 'manual-compact-tool', type: 'function', function: {
      name: 'Bash',
      arguments: JSON.stringify({
        command: 'node -e "const fs=require(\'fs\');const timer=setInterval(()=>{if(fs.existsSync(\'release-tool.txt\')){clearInterval(timer);console.log(\'工具结果_MARKER\');process.exit(0)}},50);setTimeout(()=>{clearInterval(timer);console.error(\'等待工具释放超时\');process.exit(1)},5000)"',
      }),
    } }] }
    : { content: '压缩后继续答复' });
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'compact', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('执行中需求_MARKER\n');
  await waitFor(() => output.includes('[工具] Bash：开始'), () => `输出=${output}`);

  cli.send('/compact\n');
  // 命令被输入层登记后才释放工具，确保压缩发生在工具结果写入之后。
  await waitFor(() => output.includes('已收到 /compact'), () => `输出=${output}`);
  await writeFile(join(cwd, 'release-tool.txt'), 'released');
  await waitFor(() => model.summaryRequests.length === 1, () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  await waitFor(() => output.includes('压缩后继续答复'), () => `输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;
  expect(result.code).toBe(0);

  // 摘要包含当前需求与已写入的工具结果，压缩后主模型不再看到原文。
  const summarized = summarizedMessages(model);
  expect(summarized).toContain('执行中需求_MARKER');
  expect(summarized).toContain('工具结果_MARKER');
  expect(model.requests).toHaveLength(2);
  const nextRequest = JSON.stringify(model.requests[1]!);
  expect(nextRequest).toContain(summary);
  expect(nextRequest).not.toContain('执行中需求_MARKER');

  const record = await readRecord(userDir);
  expect(record.summaries).toEqual([{ text: summary, coversThrough: 3 }]);
  expect(JSON.stringify(record.effectiveHistory)).toContain(summary);
  expect(JSON.stringify(record.effectiveHistory)).not.toContain('执行中需求_MARKER');
  expect(JSON.stringify(record.transcript)).toContain('执行中需求_MARKER');
});

it('手动压缩失败时显示错误并返回输入，原有效历史保持不变', async () => {
  const { cwd, userDir, model } = await setup(() => ({ content: '失败前答复' }), () => ({ status: 500, content: '摘要服务故障' }));
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'compact', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('失败前需求_MARKER\n');
  await waitFor(() => model.requests.length === 1 && output.includes('失败前答复'), () => `请求数=${model.requests.length}，输出=${output}`);
  const before = await waitRecord(userDir, (record) => record.effectiveHistory.length === 2, () => '首轮有效历史保存');

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 1 && output.includes('对话摘要生成失败'), () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  const afterFailure = await readRecord(userDir);
  expect(afterFailure.effectiveHistory).toEqual(before.effectiveHistory);
  expect(afterFailure.summaries).toEqual([]);

  cli.send('失败后需求\n');
  await waitFor(() => model.requests.length === 2, () => `请求数=${model.requests.length}，输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;
  expect(result.code).toBe(0);

  expect(JSON.stringify(model.requests[1]!)).toContain('失败前需求_MARKER');
  expect(JSON.stringify(model.requests[1]!)).toContain('失败后需求');
});

it('空闲压缩期间取消会返回输入并保留压缩前历史', async () => {
  const { cwd, userDir, model } = await setup(() => ({ content: '取消前答复' }), () => undefined);
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'compact', env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('取消前需求_MARKER\n');
  await waitFor(() => model.requests.length === 1 && output.includes('取消前答复'), () => `请求数=${model.requests.length}，输出=${output}`);
  const before = await waitRecord(userDir, (record) => record.effectiveHistory.length === 2, () => '首轮有效历史保存');

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 1, () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  cli.child.kill('SIGINT');
  await waitFor(() => output.includes('用户中断'), () => `输出=${output}`);
  const afterCancel = await readRecord(userDir);
  expect(afterCancel.effectiveHistory).toEqual(before.effectiveHistory);
  expect(afterCancel.summaries).toEqual([]);

  cli.send('取消后需求\n');
  await waitFor(() => model.requests.length === 2, () => `请求数=${model.requests.length}，输出=${output}`);
  cli.end('/exit\n');
  const result = await cli.done;
  expect(result.code).toBe(0);

  expect(JSON.stringify(model.requests[1]!)).toContain('取消前需求_MARKER');
  expect(JSON.stringify(model.requests[1]!)).toContain('取消后需求');
  const after = await readRecord(userDir);
  expect(JSON.stringify(after.transcript)).toContain('取消前需求_MARKER');
});