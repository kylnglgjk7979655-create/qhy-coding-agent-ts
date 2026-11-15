import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { SandboxConfig } from '../src/services/settings/config.js';
import { createSandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../src/services/sandbox/sandbox-platform.js';
import { runPlannedBash } from '../src/tools/BashTool/sandbox-bash.js';

let root: string;
let workspace: string;
let home: string;
let tmp: string;
let calls: string;
let bin: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-exec-')));
  workspace = join(root, 'workspace');
  home = join(root, 'home');
  tmp = join(root, 'tmp');
  calls = join(root, 'calls');
  bin = join(root, 'bin');
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(tmp), mkdir(calls), mkdir(bin)]);
  // 用同名的可执行替身验证执行层传参、环境与临时目录生命周期；真实 Seatbelt 行为由 macOS 集成测试覆盖。
  const proxy = join(bin, 'sandbox-exec');
  await writeFile(proxy, '#!/bin/sh\ncat "$2" > "$0.profile"\nshift 2\nexec "$@"\n');
  await chmod(proxy, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sandbox(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...DEFAULT_SANDBOX, enabled: true, ...overrides };
}

interface PlanOptions {
  command?: string;
  config?: SandboxConfig;
  envPassthrough?: string[];
  env?: NodeJS.ProcessEnv;
}

function planOptions(settings: PlanOptions = {}): Parameters<typeof createSandboxPlan>[0] {
  return {
    config: settings.config ?? sandbox({ envPassthrough: settings.envPassthrough ?? [] }),
    workspace,
    input: { command: settings.command ?? 'echo ok' },
    platform: { seatbelt: true },
    env: settings.env ?? {
      HOME: home, TMPDIR: tmp, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      SANDBOX_MARK: 'inside', SECRET_LEAK: 'should-not-pass',
    },
    tempRoot: calls,
  };
}

async function sandboxPlan(options: Parameters<typeof createSandboxPlan>[0]): Promise<Extract<SandboxPlan, { mode: 'sandbox' }>> {
  const plan = await createSandboxPlan(options);
  if (plan.mode !== 'sandbox') throw new Error(`expected sandboxed plan, got ${plan.mode}`);
  return plan;
}

describe('sandbox platform probe', () => {
  it.skipIf(process.platform === 'darwin')('非 macOS 不声称 Seatbelt 可用', async () => {
    expect(await probeSandboxPlatform()).toEqual({ seatbelt: false });
  });
});

describe('sandboxed Bash execution', () => {
  it('以 profile 启动独立 shell，仅保留最小环境与 envPassthrough，并在成功后删除临时目录', async () => {
    const config = sandbox({ envPassthrough: ['SANDBOX_MARK'] });
    const plan = await sandboxPlan(planOptions({ config }));
    expect(await readdir(calls)).toHaveLength(1);

    const result = await runPlannedBash(
      plan,
      'printf \'%s|%s\' "${SANDBOX_MARK-unset}" "${SECRET_LEAK-unset}"',
      workspace,
    );

    expect(result).toEqual({
      stdout: 'inside|unset', stderr: '', exitCode: 0, signal: null, truncated: false, sandboxed: true,
    });
    expect(await readdir(calls)).toEqual([]);
    const profile = await readFile(join(bin, 'sandbox-exec.profile'), 'utf8');
    expect(profile).toContain(`(subpath ${JSON.stringify(workspace)})`);
    expect(profile).toContain('(deny network*)');
  });

  it('非零退出保留实际输出并标记 sandboxed，失败后也删除临时目录', async () => {
    const plan = await sandboxPlan(planOptions({ command: 'exit 7' }));

    await expect(runPlannedBash(plan, 'printf problem >&2; exit 7', workspace)).rejects.toMatchObject({
      message: 'Bash 命令执行失败。',
      output: { stdout: '', stderr: 'problem', exitCode: 7, signal: null, truncated: false, sandboxed: true },
    });
    expect(await readdir(calls)).toEqual([]);
  });

  it('沙箱内 Operation not permitted 提示为策略拦截而非命令错误', async () => {
    const plan = await sandboxPlan(planOptions({ command: 'exit 1' }));

    await expect(runPlannedBash(plan, 'printf "operation not permitted\\n" >&2; exit 1', workspace)).rejects.toMatchObject({
      message: expect.stringContaining('策略拦截'),
      output: { stderr: 'operation not permitted\n', exitCode: 1, sandboxed: true },
    });
    expect(await readdir(calls)).toEqual([]);
  });

  it('超时终止进程组并删除临时目录', async () => {
    const plan = await sandboxPlan(planOptions({ command: 'sleep 5' }));

    await expect(runPlannedBash(plan, 'sleep 5', workspace, undefined, 100)).rejects.toMatchObject({
      message: 'Bash 命令执行超时。',
      output: { exitCode: null, signal: 'SIGKILL', sandboxed: true },
    });
    expect(await readdir(calls)).toEqual([]);
  });

  it('取消终止进程组并删除临时目录', async () => {
    const plan = await sandboxPlan(planOptions({ command: 'sleep 5' }));
    const controller = new AbortController();
    const operation = runPlannedBash(plan, 'sleep 5', workspace, controller.signal, 5000);
    setTimeout(() => controller.abort(new Error('已取消')), 100);

    await expect(operation).rejects.toThrow('已取消');
    expect(await readdir(calls)).toEqual([]);
  });

  it('沙箱关闭时沿用宿主执行，不生成临时目录且结果仅标记 sandboxed=false', async () => {
    const plan = await createSandboxPlan(planOptions({ config: { ...DEFAULT_SANDBOX } }));
    expect(plan).toMatchObject({ mode: 'host', sandboxed: false, reason: 'disabled' });

    const result = await runPlannedBash(plan, 'printf host', workspace);

    expect(result).toEqual({
      stdout: 'host', stderr: '', exitCode: 0, signal: null, truncated: false, sandboxed: false,
    });
    expect(await readdir(calls)).toEqual([]);
    await expect(readFile(join(bin, 'sandbox-exec.profile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fail-closed 计划拒绝执行且不退回宿主路径', async () => {
    const unavailable = await createSandboxPlan({
      ...planOptions({ command: 'printf must-not-run > executed.txt', config: sandbox({ onUnavailable: 'closed' }) }),
      platform: { seatbelt: false },
    });
    expect(unavailable).toMatchObject({ mode: 'reject' });

    await expect(runPlannedBash(unavailable, 'printf must-not-run > executed.txt', workspace)).rejects.toMatchObject({
      output: { sandboxed: false },
    });
    await expect(readFile(join(workspace, 'executed.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(calls)).toEqual([]);
  });
});