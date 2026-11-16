import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { tempDir } from './helpers/temp-dir.js';

describe.skipIf(process.platform !== 'darwin')('真实 CLI 中的 Seatbelt 沙箱', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    { description: '默认拒绝 curl 写入 /dev/null', target: '/dev/null', writePaths: [], writeDenyPaths: [], allowed: false },
    { description: '允许 curl 写入工作区文件', target: 'output.txt', writePaths: [], writeDenyPaths: [], allowed: true },
    { description: '用户可通过写白名单允许 /dev/null', target: '/dev/null', writePaths: ['/dev/null'], writeDenyPaths: [], allowed: true },
    { description: '写拒绝优先于用户追加的空设备写权限', target: '/dev/null', writePaths: ['/dev/null'], writeDenyPaths: ['/dev/null'], allowed: false },
  ])('$description', async ({ target, writePaths, writeDenyPaths, allowed }) => {
    const root = await tempDir('qhy-sandbox-cli-');
    roots.push(root);
    const workspace = join(root, 'work');
    const home = join(root, 'home');
    await Promise.all([mkdir(workspace), mkdir(home)]);
    await mkdir(join(workspace, '.agent'));
    await writeFile(join(workspace, 'input.txt'), 'fixture response');
    const command = `/usr/bin/curl -sS -o ${target} file://${workspace}/input.txt`;
    const model = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'curl-null', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command }),
      } }] }
      : { content: '完成' });
    try {
      await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
        model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
        timeoutMs: 5000, maxSteps: 5,
        permissions: {
          allow: ['Bash(/usr/bin/curl:*)'],
          sandbox: { enabled: true, onUnavailable: 'closed', writePaths, writeDenyPaths },
        },
      }));
      const cli = startCLI({
        cwd: workspace, userDir: home, env: { TEST_MODEL_API_KEY: 'fixture-key' }, input: '执行命令\n/exit\n',
      });
      const result = await cli.done;
      expect(result.code, result.stderr).toBe(0);
      const tool = model.requests.at(-1)?.messages.find(({ role }) => role === 'tool');
      expect(tool, result.stdout + result.stderr).toBeDefined();
      expect(JSON.parse(tool!.content)).toMatchObject(allowed
        ? { is_error: false, output: { exitCode: 0, stderr: '', sandboxed: true } }
        : { is_error: true, output: { exitCode: 23, stderr: expect.stringContaining('Failure writing'), sandboxed: true } });
      if (target === 'output.txt') await expect(readFile(join(workspace, target), 'utf8')).resolves.toBe('fixture response');
    } finally {
      await model.close();
    }
  });
});
