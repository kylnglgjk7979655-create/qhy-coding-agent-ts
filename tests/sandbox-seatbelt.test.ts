import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { SandboxConfig } from '../src/services/settings/config.js';
import { cleanupSandboxPlan, createSandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
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
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qhy-seatbelt-')));
    workspace = join(root, 'workspace');
    home = join(root, 'home');
    tmp = join(root, 'tmp');
    calls = join(root, 'calls');
    outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(home), mkdir(tmp), mkdir(calls), mkdir(outside)]);
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'authorized_keys'), 'private-key');
    await writeFile(join(home, 'plain.txt'), 'plain-content');
    await writeFile(join(outside, 'read.txt'), 'outside-read');
    await mkdir(join(workspace, '.agent'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function sandbox(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return { ...DEFAULT_SANDBOX, enabled: true, ...overrides };
  }

  async function sandboxPlan(
    command: string,
    config: Partial<SandboxConfig> = {},
  ): Promise<Extract<SandboxPlan, { mode: 'sandbox' }>> {
    const plan = await createSandboxPlan({
      config: sandbox(config),
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

  /** 断言命令被沙箱策略拦截而非命令本身出错；文件不得产生副作用。 */
  async function expectDenied(plan: Extract<SandboxPlan, { mode: 'sandbox' }>, command: string, cwd = workspace) {
    const error = await runPlannedBash(plan, command, cwd).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      message: expect.stringContaining('策略拦截'),
      output: { sandboxed: true, exitCode: 1 },
    });
    expect((error as { output: { stderr: string } }).output.stderr).toMatch(/Operation not permitted/i);
    expect(await readdir(calls)).toEqual([]);
  }

  function quote(path: string): string {
    return JSON.stringify(path);
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
    const outsideFile = join(root, 'outside.txt');
    // 由 shell 子进程执行，验证 profile 同样约束命令派生出的进程。
    const command = `/bin/sh -c ${JSON.stringify(`printf blocked > ${outsideFile}`)}`;
    const plan = await sandboxPlan(command);

    await expectDenied(plan, command);

    await expect(readFile(outsideFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('读取内置敏感路径失败，读取普通路径成功', async () => {
    const denied = `cat ${quote(join(home, '.ssh', 'authorized_keys'))}`;
    await expectDenied(await sandboxPlan(denied), denied);

    const allowed = `cat ${quote(join(home, 'plain.txt'))}`;
    const result = await runPlannedBash(await sandboxPlan(allowed), allowed, workspace);
    expect(result).toMatchObject({ stdout: 'plain-content', stderr: '', exitCode: 0, sandboxed: true });
  });

  it('readAllowPaths 精确放开黑名单项，目录本身仍不可读', async () => {
    const config = { readAllowPaths: [join(home, '.ssh', 'authorized_keys')] };
    const allowed = `cat ${quote(join(home, '.ssh', 'authorized_keys'))}`;
    const result = await runPlannedBash(await sandboxPlan(allowed, config), allowed, workspace);
    expect(result).toMatchObject({ stdout: 'private-key', exitCode: 0, sandboxed: true });

    const listing = `ls ${quote(join(home, '.ssh'))}`;
    await expectDenied(await sandboxPlan(listing, config), listing);
  });

  it('工作区内的符号链接不能借 realpath 绕过读拒绝', async () => {
    await symlink(join(home, '.ssh', 'authorized_keys'), join(workspace, 'key-link'));
    await symlink(join(home, '.ssh'), join(workspace, 'ssh-link'));

    const fileLink = 'cat key-link';
    await expectDenied(await sandboxPlan(fileLink), fileLink);

    const directoryLink = 'cat ssh-link/authorized_keys';
    await expectDenied(await sandboxPlan(directoryLink), directoryLink);
  });

  it('工作区、$TMPDIR、调用临时目录与追加写路径可写', async () => {
    const extra = join(root, 'extra');
    await mkdir(extra);
    const plan = await sandboxPlan('true', { writePaths: [extra] });
    const command = [
      `printf workspace > ${quote(join(workspace, 'workspace.txt'))}`,
      `printf tmpdir > ${quote(join(tmp, 'tmpdir.txt'))}`,
      `printf call > ${quote(join(plan.tempDir, 'call.txt'))}`,
      `printf extra > ${quote(join(extra, 'extra.txt'))}`,
      `cat ${quote(join(plan.tempDir, 'call.txt'))}`,
    ].join(' && ');

    const result = await runPlannedBash(plan, command, workspace);

    expect(result).toMatchObject({ stdout: 'call', stderr: '', exitCode: 0, sandboxed: true });
    expect(await readFile(join(workspace, 'workspace.txt'), 'utf8')).toBe('workspace');
    expect(await readFile(join(tmp, 'tmpdir.txt'), 'utf8')).toBe('tmpdir');
    expect(await readFile(join(extra, 'extra.txt'), 'utf8')).toBe('extra');
    await expect(stat(plan.tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(calls)).toEqual([]);
  });

  it('内置防篡改路径不可写，且写允许不能覆盖内置写拒绝', async () => {
    const target = join(workspace, '.agent', 'settings.local.json');
    const plan = await sandboxPlan(`printf hacked > ${quote(target)}`, {
      writePaths: [join(workspace, '.agent')],
    });

    await expectDenied(plan, `printf hacked > ${quote(target)}`);

    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('尚不存在的内置防篡改子树也不能创建', async () => {
    const target = join(workspace, '.claude', 'skills', 'evil.md');
    const command = `mkdir -p ${quote(join(workspace, '.claude', 'skills'))} && printf evil > ${quote(target)}`;
    const plan = await sandboxPlan(command, { writePaths: [join(workspace, '.claude')] });

    await expectDenied(plan, command);

    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('工作区外的启动目录可读但不可写', async () => {
    const read = await runPlannedBash(await sandboxPlan('cat read.txt'), 'cat read.txt', outside);
    expect(read).toMatchObject({ stdout: 'outside-read', exitCode: 0, sandboxed: true });

    const command = 'printf written > created.txt';
    await expectDenied(await sandboxPlan(command), command, outside);

    await expect(readFile(join(outside, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('调用结束后临时目录被删除，跨调用不共享数据', async () => {
    const first = await sandboxPlan('true');
    const firstCommand = `printf first > ${quote(join(first.tempDir, 'marker'))}`;
    await runPlannedBash(first, firstCommand, workspace);
    await expect(stat(first.tempDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await sandboxPlan('true');
    expect(second.tempDir).not.toBe(first.tempDir);
    await expect(readFile(join(second.tempDir, 'marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await cleanupSandboxPlan(second);
    expect(await readdir(calls)).toEqual([]);
  });
});
