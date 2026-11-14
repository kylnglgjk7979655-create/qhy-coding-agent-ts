import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const secret = 'task-status-cli-test-key';
const summary = '目标：压缩后附加待关注任务状态；约束：只读且不改变任务；结果：状态资料已附加；未完成事项：继续当前任务。';
const conversationId = 'task-status';
const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待 CLI 状态超时：${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-task-status-cli-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-task-status-cli-user-'));
  roots.push(cwd, userDir);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  return { cwd, userDir };
}

async function configure(cwd: string, baseURL: string): Promise<void> {
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL,
    timeoutMs: 6000, maxSteps: 10, approval: { mode: 'auto' },
    permissions: { allow: ['Bash(node:*)'] },
    // 容量足够大，隔离自动阈值，统一用 /compact 触发压缩。
    context: { capacityTokens: 100_000, answerReserveTokens: 700, maxOutputTokens: 1_000 },
  }));
}

function tasksDirectory(userDir: string): string {
  return join(userDir, '.qhy-coding-agents', 'sessions', conversationId, 'tasks');
}

function recordPath(userDir: string): string {
  return join(userDir, '.qhy-coding-agents', 'sessions', conversationId, 'record.json');
}

interface SavedRecord {
  effectiveHistory: Array<{ role: string; content: unknown }>;
}

async function readRecord(userDir: string): Promise<SavedRecord> {
  return JSON.parse(await readFile(recordPath(userDir), 'utf8')) as SavedRecord;
}

async function waitRecord(userDir: string, predicate: (record: SavedRecord) => boolean, describe: string): Promise<SavedRecord> {
  const deadline = Date.now() + 6000;
  while (true) {
    const record = await readRecord(userDir);
    if (predicate(record)) return record;
    if (Date.now() >= deadline) throw new Error(`等待会话记录超时：${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function taskStatusContent(record: SavedRecord): string | undefined {
  for (const message of record.effectiveHistory) {
    if (typeof message.content === 'string' && message.content.includes('[后台任务状态]')) return message.content;
  }
  return undefined;
}

function extractTaskId(requests: unknown[]): string {
  // 工具结果可能作为字符串再次序列化，任务 ID 两侧的引号可能带转义。
  const match = /taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(JSON.stringify(requests));
  if (!match) throw new Error('未找到后台任务 ID');
  return match[1]!;
}

async function waitTaskFile(userDir: string): Promise<string> {
  const deadline = Date.now() + 6000;
  while (true) {
    try {
      const file = (await readdir(tasksDirectory(userDir))).find((name) => name.endsWith('.json'));
      if (file) return file.slice(0, -'.json'.length);
    } catch {
      // 任务尚未持久化结果文件。
    }
    if (Date.now() >= deadline) throw new Error('等待后台任务结果文件超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('CLI 压缩附加运行中任务状态，通知后再次压缩不再列出已读取任务', async () => {
  const { cwd, userDir } = await setup();
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const model = await startLocalOpenAIModel(async (request, index) => {
    const userText = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n');
    if (userText.includes('任务：后台子任务')) {
      await childGate;
      return { content: '后台结果_MARKER' };
    }
    if (index === 1) return { calls: [{ id: 'launch-background', type: 'function', function: {
      name: 'agent', arguments: JSON.stringify({ description: '后台调查', prompt: '后台子任务', background: true }),
    } }] };
    return { content: '主轮次完成' };
  }, undefined, () => ({ content: summary }));
  fixtures.push(model);
  await configure(cwd, model.baseURL);

  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('启动后台调查\n');
  await waitFor(() => model.requests.length >= 2 && output.includes('主轮次完成'), () => `请求数=${model.requests.length}，输出=${output}`);
  const taskId = extractTaskId(model.requests);

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 1 && output.includes('已压缩当前会话历史'), () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  const compacted = await waitRecord(userDir, (record) => taskStatusContent(record)?.includes(taskId) === true, '等待运行中任务状态');
  const runningStatus = taskStatusContent(compacted)!;
  expect(runningStatus).toContain('后台调查');
  expect(runningStatus).toContain('running');
  expect(runningStatus).not.toContain('后台结果_MARKER');
  // 运行中任务尚未持久化结果文件。
  await expect(readdir(tasksDirectory(userDir))).rejects.toMatchObject({ code: 'ENOENT' });

  releaseChild();
  await waitFor(() => output.includes('[后台任务通知] 后台调查：succeeded'), () => `输出=${output}`);
  // 压缩没有领取结果：完成后仍通过原通知通路送达完整回复。
  await waitFor(() => model.requests.some((request) => request.messages.some(({ role, content }) => role === 'user' && content.includes('后台子 Agent 已完成'))), () => `请求数=${model.requests.length}，输出=${output}`);
  expect(JSON.stringify(model.requests)).toContain('后台结果_MARKER');

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 2 && output.includes('已压缩当前会话历史'), () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  await waitRecord(userDir, (record) => !taskStatusContent(record)?.includes(taskId), '等待已读取任务从附件移除');
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);
});

it('CLI 执行中压缩附加终态未读取任务，通知后再次压缩不再列出已读取任务', async () => {
  const { cwd, userDir } = await setup();
  const model = await startLocalOpenAIModel(async (request, index) => {
    const userText = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n');
    if (userText.includes('任务：快速后台任务')) return { content: '快速后台结果_MARKER' };
    if (index === 1) return { calls: [
      { id: 'launch-fast-background', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '快速调查', prompt: '快速后台任务', background: true }),
      } },
      { id: 'block-parent', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({
          command: 'node -e "const fs=require(\'fs\');const timer=setInterval(()=>{if(fs.existsSync(\'release-parent.txt\')){clearInterval(timer);console.log(\'工具结果_MARKER\');process.exit(0)}},50);setTimeout(()=>{clearInterval(timer);console.error(\'等待工具释放超时\');process.exit(1)},5000)"',
        }),
      } },
    ] };
    return { content: '主轮次完成' };
  }, undefined, () => ({ content: summary }));
  fixtures.push(model);
  await configure(cwd, model.baseURL);

  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  cli.send('启动快速任务\n');
  await waitFor(() => output.includes('[工具] Bash：开始'), () => `输出=${output}`);
  // 父轮次被 Bash 阻塞时，后台任务已经结束并写入结果文件，但通知尚未被处理。
  const taskId = await waitTaskFile(userDir);

  cli.send('/compact\n');
  await waitFor(() => output.includes('已收到 /compact'), () => `输出=${output}`);
  await waitFor(() => model.summaryRequests.length === 1, () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  await writeFile(join(cwd, 'release-parent.txt'), 'released');
  await waitFor(() => output.includes('主轮次完成'), () => `输出=${output}`);
  await waitFor(() => output.includes('[后台任务通知] 快速调查：succeeded'), () => `输出=${output}`);

  const compacted = await waitRecord(userDir, (record) => taskStatusContent(record)?.includes(taskId) === true, '等待终态未读取任务状态');
  const terminalStatus = taskStatusContent(compacted)!;
  expect(terminalStatus).toContain('快速调查');
  expect(terminalStatus).toContain('succeeded');
  expect(terminalStatus).toContain(join(tasksDirectory(userDir), `${taskId}.json`));
  expect(terminalStatus).not.toContain('快速后台结果_MARKER');

  cli.send('/compact\n');
  await waitFor(() => model.summaryRequests.length === 2 && output.includes('已压缩当前会话历史'), () => `摘要请求数=${model.summaryRequests.length}，输出=${output}`);
  await waitRecord(userDir, (record) => !taskStatusContent(record)?.includes(taskId), '等待已读取任务从附件移除');
  cli.end('/exit\n');
  expect((await cli.done).code).toBe(0);
});