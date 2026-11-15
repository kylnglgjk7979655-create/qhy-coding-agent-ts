import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import { createSandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../src/services/sandbox/sandbox-platform.js';
import { runPlannedBash } from '../src/tools/BashTool/sandbox-bash.js';

// 只有 macOS 具备可验证的 Seatbelt 实现；其他平台跳过真实 sandbox-exec 用例。
describe.skipIf(process.platform !== 'darwin')('真实 Seatbelt 沙箱执行', () => {
  let root: string;
  let workspace: string;
  let home: string;
  let tmp: string;
  let calls: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qhy-seatbelt-')));
    workspace = join(root, 'workspace');
    home = join(root, 'home');
    tmp = join(root, 'tmp');
    calls = join(root, 'calls');
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(tmp), mkdir(calls)]);
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'authorized_keys'), 'private-key');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function sandboxPlan(command: string): Promise<Extract<SandboxPlan, { mode: 'sandbox' }>> {
    const plan = await createSandboxPlan({
      config: { ...DEFAULT_SANDBOX, enabled: true },
      workspace,
      input: { command },
      platform: await probeSandboxPlatform(),
      env: { ...process.env, HOME: home, TMPDIR: tmp },
      tempRoot: calls,
      home,
    });
    if (plan.mode !== 'sandbox') throw new Error(`expected sandboxed plan, got ${plan.mode}`);
    return plan;
  }

  it('sandbox-exec 执行成功、允许工作区写入并清理临时目录', async () => {
    expect(await probeSandboxPlatform()).toEqual({ seatbelt: true });
    const plan = await sandboxPlan('printf real-seatbelt > marker.txt; printf ok');

    const result = await runPlannedBash(plan, 'printf real-seatbelt > marker.txt; printf ok', workspace);

    expect(result).toEqual({
      stdout: 'ok', stderr: '', exitCode: 0, signal: null, truncated: false, sandboxed: true,
    });
    expect(await readFile(join(workspace, 'marker.txt'), 'utf8')).toBe('real-seatbelt');
    expect(await readdir(calls)).toEqual([]);
  });

  it('拒绝写入沙箱外路径并提示策略拦截而非命令错误', async () => {
    const outside = join(root, 'outside.txt');
    // 由 shell 子进程执行，验证 profile 同样约束命令派生出的进程。
    const command = `/bin/sh -c ${JSON.stringify(`printf blocked > ${outside}`)}`;
    const plan = await sandboxPlan(command);

    const error = await runPlannedBash(plan, command, workspace).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      message: expect.stringContaining('策略拦截'),
      output: { sandboxed: true, exitCode: 1 },
    });
    expect((error as { output: { stderr: string } }).output.stderr).toMatch(/Operation not permitted/i);
    await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(calls)).toEqual([]);
  });
});