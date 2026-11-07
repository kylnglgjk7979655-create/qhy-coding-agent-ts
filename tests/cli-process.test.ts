import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

let temporaryDirectory = '';
let model: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;

afterEach(async () => {
  await model?.close();
  model = undefined;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('drives a compiled CLI incrementally from independent startup directories', async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'qhy-cli-driver-'));
  const home = join(temporaryDirectory, 'isolated-home');
  const firstWorkspace = join(temporaryDirectory, 'first');
  const secondWorkspace = join(temporaryDirectory, 'second');
  await Promise.all([mkdir(home), mkdir(firstWorkspace), mkdir(secondWorkspace)]);
  model = await startLocalOpenAIModel((_request, index) => {
    if (index === 1) return { calls: [{ id: 'driver-write', type: 'function', function: {
      name: 'write_file', arguments: JSON.stringify({ path: 'observed.txt', content: 'file side effect' }),
    } }] };
    return { content: index === 2 ? '第一轮完成' : index === 3 ? '第二轮完成' : `第${index - 1}轮完成` };
  });
  const config = JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model!.baseURL,
    workspace: '.', timeoutMs: 3000, approval: { rules: [{ toolName: 'write_file', action: 'allow' }] },
  });
  const isolatedConfig = join(home, 'agent.config.json');
  await writeFile(isolatedConfig, config);

  let observedOutput = '';
  const first = startCLI({
    cwd: firstWorkspace,
    userDir: home,
    args: ['--config', isolatedConfig],
    env: { TEST_MODEL_API_KEY: 'driver-fixture-key' },
  }, (stdout) => { observedOutput = stdout; });
  first.send('第一条输入\n');
  await waitFor(() => observedOutput.includes('第一轮完成'), 'CLI did not finish the first incremental input');
  expect(await readFile(join(firstWorkspace, 'observed.txt'), 'utf8')).toBe('file side effect');
  first.send('第二条输入\n/exit\n');
  first.endInput();
  const firstResult = await first.done;
  expect(firstResult.code).toBe(0);
  expect(firstResult.stdout).toContain('第二轮完成');

  const firstLog = firstResult.stderr.split('\n').map((line) => {
    try { return JSON.parse(line) as { event?: string; conversationId?: string } } catch { return {}; }
  }).find((entry) => entry.event === 'run.started');
  expect(firstLog?.conversationId).toEqual(expect.any(String));
  const conversationFiles = await readdir(join(firstWorkspace, '.agent', 'conversations'));
  expect(conversationFiles).toEqual([`${firstLog?.conversationId}.json`]);
  const history = await readFile(join(firstWorkspace, '.agent', 'conversations', conversationFiles[0]!), 'utf8');
  expect(history).toContain('第一条输入');
  expect(history).toContain('第二条输入');

  const second = startCLI({
    cwd: secondWorkspace,
    userDir: home,
    args: ['--config', isolatedConfig],
    input: '另一启动目录\n/exit\n',
    env: { TEST_MODEL_API_KEY: 'driver-fixture-key' },
  });
  const secondResult = await second.done;
  expect(secondResult.code).toBe(0);
  expect(secondResult.stdout).toContain('第3轮完成');
  const secondLog = secondResult.stderr.split('\n').map((line) => {
    try { return JSON.parse(line) as { event?: string; conversationId?: string } } catch { return {}; }
  }).find((entry) => entry.event === 'run.started');
  expect(secondLog?.conversationId).toEqual(expect.any(String));
  expect(secondLog?.conversationId).not.toBe(firstLog?.conversationId);
  expect(await readdir(join(secondWorkspace, '.agent', 'conversations'))).toEqual([`${secondLog?.conversationId}.json`]);
  expect(model.requests.map(({ messages }) => messages.filter(({ role }) => role === 'user').at(-1)?.content)).toEqual([
    '第一条输入', '第一条输入', '第二条输入', '另一启动目录',
  ]);
});
