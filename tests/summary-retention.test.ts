import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const secret = 'summary-retention-test-key';
let roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 CLI 会话更新超时：${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('跨进程复用已保存摘要，保留摘要覆盖的完整 transcript 和正确边界', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-summary-retention-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-summary-retention-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(
    (_request, index) => ({ content: `答复 ${index}` }),
    undefined,
    () => ({ content: '摘要目标：跨进程续聊；约束：保留完整原文；结果：前序消息已处理；未完成：继续工作。' }),
  );
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 3000, maxSteps: 10, approval: { mode: 'auto' },
    // 工具定义进入上下文预算后，留出空间让本例仍在第 4 轮触发一次全历史摘要。
    context: { capacityTokens: 18_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));

  let output = '';
  const cli = startCLI({ cwd, userDir, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  const prompts = [1, 2, 3, 4, 5].map((index) => `历史轮次 ${index} 原文标记_${index} ${'旧'.repeat(800)}`);
  for (const [index, prompt] of prompts.entries()) {
    cli.send(`${prompt}\n`);
    await waitFor(() => model.requests.length === index + 1 && output.includes(`答复 ${index + 1}`), () => `请求数=${model.requests.length}，输出=${output}`);
  }
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);
  expect(model.summaryRequests).toHaveLength(1);

  const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
  expect(conversationId).toBeTruthy();
  const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', conversationId!, 'record.json');
  const saved = JSON.parse(await readFile(recordPath, 'utf8')) as {
    transcript: Array<{ role: string; content: unknown }>;
    effectiveHistory: unknown[];
    summaries: Array<{ text: string; coversThrough: number }>;
  };

  for (const prompt of prompts) expect(JSON.stringify(saved.transcript)).toContain(prompt);
  expect(saved.summaries).toEqual([{
    text: '摘要目标：跨进程续聊；约束：保留完整原文；结果：前序消息已处理；未完成：继续工作。',
    coversThrough: 7,
  }]);
  // 摘要覆盖触发时的全部有效历史：前三轮问答与当前需求原文都进入摘要请求。
  const summarized = JSON.parse(model.summaryRequests[0]!.messages[1]!.content) as Array<{ role: string; content: string }>;
  expect(summarized.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(prompts.slice(0, 4));
  expect(JSON.stringify(saved.effectiveHistory)).toContain('摘要目标：跨进程续聊');
  expect(JSON.stringify(saved.effectiveHistory)).not.toContain('历史轮次 1 原文标记_1');

  const resumed = startCLI({ cwd, userDir, conversationId: conversationId!, input: '重启后续聊\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await resumed.done).code).toBe(0);
  expect(model.summaryRequests).toHaveLength(1);
  const resumedRequest = model.requests.at(-1)!;
  expect(JSON.stringify(resumedRequest)).toContain('摘要目标：跨进程续聊');
  expect(JSON.stringify(resumedRequest)).not.toContain('历史轮次 1 原文标记_1');
  expect(resumedRequest.messages
    .filter(({ role, content }) => role === 'user' && !content.includes('[对话摘要]'))
    .map(({ content }) => content)).toEqual([prompts[4]!, '重启后续聊']);
  const afterResume = JSON.parse(await readFile(recordPath, 'utf8')) as typeof saved;
  expect(afterResume.summaries).toEqual(saved.summaries);
});

it('压缩检查点覆盖更早的中断轮次，重启后不重复回放已覆盖消息', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-summary-replay-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-summary-replay-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(
    (_request, index) => ({ content: `答复 ${index}` }),
    undefined,
    () => ({ content: '检查点摘要_MARKER' }),
  );
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 3000, maxSteps: 10, approval: { mode: 'auto' },
    // 容量足够大，隔离自动阈值，避免新摘要掩盖重复回放。
    context: { capacityTokens: 100_000, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
  const cli = startCLI({ cwd, userDir, conversationId: 'replay', input: '初始需求\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await cli.done).code).toBe(0);

  // 构造会话记录：更早的中断轮次已进入后续轮次的压缩检查点，但该轮自身没有 compactedThrough。
  const recordPath = join(userDir, '.qhy-coding-agents', 'sessions', 'replay', 'record.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
  const transcript = [
    { role: 'user', content: '已覆盖旧轮用户_MARKER' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'covered-call', toolName: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'covered-call', toolName: 'read_file', output: { is_error: false, output: { content: 'X' } } }] },
  ];
  await writeFile(recordPath, JSON.stringify({
    ...record,
    title: '复述检查',
    transcript,
    effectiveHistory: [{ role: 'user', content: '[对话摘要]\n检查点摘要_MARKER' }],
    summaries: [{ text: '检查点摘要_MARKER', coversThrough: 3 }],
    recentFiles: [],
    checkpoints: [],
    backups: [],
    rounds: [
      { id: 'covered-round', status: 'running', startedAt: new Date().toISOString(), transcriptStart: 0, messages: transcript },
      { id: 'checkpoint-round', status: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), transcriptStart: 3, compactedThrough: 3, error: { code: 'PROVIDER_ERROR', message: '摘要后失败' } },
    ],
  }));

  const resumed = startCLI({ cwd, userDir, conversationId: 'replay', input: '重启续聊\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await resumed.done).code).toBe(0);
  const request = model.requests.at(-1)!;
  expect(JSON.stringify(request)).toContain('检查点摘要_MARKER');
  // 检查点已覆盖更早的中断轮次；重启后不得在摘要之上重复回放其原文。
  expect(JSON.stringify(request)).not.toContain('已覆盖旧轮用户_MARKER');
  const after = JSON.parse(await readFile(recordPath, 'utf8')) as { rounds: Array<{ id: string; recovered?: boolean }> };
  expect(after.rounds.find(({ id }) => id === 'covered-round')?.recovered).toBe(true);
});

it('迁移旧版工作区历史时将摘要原文纳入新会话 transcript', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-summary-migration-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-summary-migration-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(
    () => ({ content: '迁移后完成' }),
    undefined,
    () => ({ content: '旧目标摘要；约束：保留完整原文；未完成：继续工作。' }),
  );
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 3000, maxSteps: 10, approval: { mode: 'auto' },
    context: { capacityTokens: 18_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
  const legacyHistory = [
    { role: 'user', content: '旧版需求_MARKER' },
    { role: 'assistant', content: `旧版对话原文_MARKER ${'旧'.repeat(5000)}` },
  ];
  await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'conversations', 'legacy-summary.json'), JSON.stringify(legacyHistory));

  const cli = startCLI({ cwd, userDir, conversationId: 'legacy-summary', input: '迁移后的新需求\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  expect((await cli.done).code).toBe(0);
  expect(model.summaryRequests).toHaveLength(1);
  const record = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', 'legacy-summary', 'record.json'), 'utf8')) as {
    transcript: unknown[];
    summaries: Array<{ text: string; coversThrough: number }>;
  };
  expect(record.transcript.slice(0, 2)).toEqual(legacyHistory);
  expect(JSON.stringify(record.transcript)).toContain('旧版对话原文_MARKER');
  expect(record.summaries[0]?.coversThrough).toBe(3);
});

it('摘要压缩校验失败时保留完整 transcript 且不保存无效摘要', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-summary-budget-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-summary-budget-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(
    () => ({ content: '不得发送的主模型请求' }),
    undefined,
    () => ({ content: '过长摘要'.repeat(2000) }),
  );
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 3000, maxSteps: 10, approval: { mode: 'auto' },
    context: { capacityTokens: 18_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
  const legacyHistory = [
    { role: 'user', content: '预算失败前的旧需求_MARKER' },
    { role: 'assistant', content: `预算失败时仍须保留的原文_MARKER ${'旧'.repeat(5000)}` },
  ];
  await mkdir(join(cwd, '.agent', 'conversations'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'conversations', 'budget-summary.json'), JSON.stringify(legacyHistory));

  const cli = startCLI({ cwd, userDir, conversationId: 'budget-summary', input: '压缩失败轮\n/exit\n', env: { TEST_MODEL_API_KEY: secret } });
  const result = await cli.done;
  expect(result.stdout + result.stderr).toContain('CONTEXT_ERROR');
  expect(model.summaryRequests).toHaveLength(1);
  expect(model.requests).toEqual([]);
  const record = JSON.parse(await readFile(join(userDir, '.qhy-coding-agents', 'sessions', 'budget-summary', 'record.json'), 'utf8')) as {
    transcript: unknown[];
    effectiveHistory: unknown[];
    summaries: Array<{ text: string; coversThrough: number }>;
  };
  expect(record.transcript.slice(0, 2)).toEqual(legacyHistory);
  expect(record.effectiveHistory).toEqual(legacyHistory);
  expect(JSON.stringify(record.transcript)).toContain('预算失败时仍须保留的原文_MARKER');
  expect(record.summaries).toEqual([]);
});
