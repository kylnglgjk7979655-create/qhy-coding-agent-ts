import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { SandboxConfig } from '../src/services/settings/config.js';
import { createSandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../src/services/sandbox/sandbox-platform.js';
import { startSandboxNetwork } from '../src/services/sandbox/sandbox-network.js';
import type { SandboxNetwork } from '../src/services/sandbox/sandbox-network.js';
import type { ProxyViolation } from '../src/services/sandbox/network-proxy.js';
import { runPlannedBash } from '../src/tools/BashTool/sandbox-bash.js';

const VIOLATION_TIME = 1_700_000_000_000;

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
  proxyPort?: number;
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
    ...(settings.proxyPort === undefined ? {} : { proxyPort: settings.proxyPort }),
  };
}

/** 以注入的代理会话验证执行层的违规回传与生命周期，不依赖真实监听。 */
function fakeNetwork(violations: readonly ProxyViolation[] = []): SandboxNetwork & { close: ReturnType<typeof vi.fn> } {
  return { port: 4567, violations, close: vi.fn(async () => {}) };
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

  it('fail-open 时照常执行，结果标记 sandboxed=false 并携带未隔离通知', async () => {
    const unavailable = await createSandboxPlan({
      ...planOptions({ config: sandbox({ onUnavailable: 'open' }) }),
      platform: { seatbelt: false },
    });
    expect(unavailable).toMatchObject({ mode: 'host', sandboxed: false, reason: 'unavailable' });

    const result = await runPlannedBash(unavailable, 'printf host-open', workspace);

    expect(result).toMatchObject({
      stdout: 'host-open', stderr: '', exitCode: 0, signal: null, truncated: false, sandboxed: false,
      notice: expect.stringContaining('未隔离'),
    });
    expect(await readdir(calls)).toEqual([]);
  });

  it('fail-closed 计划拒绝执行、给出原因且不启动命令进程', async () => {
    // 用同名 bash 替身记录任何命令进程启动；fail-closed 必须在 spawn 前拒绝。
    const spawned = join(root, 'spawned');
    const fakeBash = join(bin, 'bash');
    await writeFile(fakeBash, `#!/bin/sh\nprintf spawned > ${JSON.stringify(spawned)}\nexec /bin/bash "$@"\n`);
    await chmod(fakeBash, 0o755);
    const unavailable = await createSandboxPlan({
      ...planOptions({ command: 'printf must-not-run > executed.txt', config: sandbox({ onUnavailable: 'closed' }) }),
      platform: { seatbelt: false },
    });
    expect(unavailable).toMatchObject({ mode: 'reject' });

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    try {
      await expect(runPlannedBash(unavailable, 'printf must-not-run > executed.txt', workspace)).rejects.toMatchObject({
        message: expect.stringContaining('closed'),
        output: { sandboxed: false, notice: expect.stringContaining('closed') },
      });
    } finally {
      process.env.PATH = originalPath;
    }
    await expect(readFile(spawned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'executed.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(calls)).toEqual([]);
  });
});

describe('sandboxed Bash network proxy wiring', () => {
  it('子进程获得约定的代理环境变量', async () => {
    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      proxyPort: 4567,
    }));
    const network = fakeNetwork();

    const result = await runPlannedBash(
      plan,
      `printf '%s|%s|%s' "$HTTPS_PROXY" "$http_proxy" "$ALL_PROXY"`,
      workspace,
      undefined,
      30_000,
      network,
    );

    expect(result.stdout).toBe('http://localhost:4567|http://localhost:4567|http://localhost:4567');
    expect(network.close).toHaveBeenCalledOnce();
  });

  it('成功命令把代理违规汇总为 sandbox_violations 附加到输出，并在结束后关闭代理', async () => {
    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      proxyPort: 4567,
    }));
    const network = fakeNetwork([
      { host: 'evil.example', port: 443, reason: 'host-not-allowed', timestamp: VIOLATION_TIME },
      { host: 'registry.npmjs.org', port: 8080, reason: 'port-not-allowed', timestamp: VIOLATION_TIME },
    ]);

    const result = await runPlannedBash(plan, 'printf ok', workspace, undefined, 30_000, network);

    expect(result.stdout).toBe('ok');
    expect(result.stderr).toContain('<sandbox_violations>');
    expect(result.stderr).toContain('evil.example:443');
    expect(result.stderr).toContain('域名不在白名单（host-not-allowed）');
    expect(result.stderr).toContain('registry.npmjs.org:8080');
    expect(result.stderr).toContain('端口不在白名单（port-not-allowed）');
    expect(result.stderr.endsWith('</sandbox_violations>')).toBe(true);
    expect(network.close).toHaveBeenCalledOnce();
    expect(await readdir(calls)).toEqual([]);
  });

  it('命令失败时违规同样附加到错误输出，模型可区分策略拒绝与命令错误', async () => {
    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      proxyPort: 4567,
    }));
    const network = fakeNetwork([
      { host: '169.254.169.254', port: 80, reason: 'dangerous-address', timestamp: VIOLATION_TIME },
    ]);

    const error = await runPlannedBash(plan, 'printf problem >&2; exit 7', workspace, undefined, 30_000, network)
      .catch((reason: unknown) => reason) as { message: string; output: { stderr: string; exitCode: number } };

    expect(error.message).toBe('Bash 命令执行失败。');
    expect(error.output).toMatchObject({ exitCode: 7 });
    expect(error.output.stderr).toContain('problem');
    expect(error.output.stderr).toContain('<sandbox_violations>');
    expect(error.output.stderr).toContain('169.254.169.254:80');
    expect(error.output.stderr).toContain('dangerous-address');
    expect(network.close).toHaveBeenCalledOnce();
    expect(await readdir(calls)).toEqual([]);
  });

  it('没有违规时不附加 sandbox_violations，代理仍在结束后关闭', async () => {
    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      proxyPort: 4567,
    }));
    const network = fakeNetwork();

    const result = await runPlannedBash(plan, 'printf clean', workspace, undefined, 30_000, network);

    expect(result).toEqual({
      stdout: 'clean', stderr: '', exitCode: 0, signal: null, truncated: false, sandboxed: true,
    });
    expect(network.close).toHaveBeenCalledOnce();
  });

  it('超时终止命令时也关闭代理', async () => {
    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      proxyPort: 4567,
      command: 'sleep 5',
    }));
    const network = fakeNetwork();

    await expect(runPlannedBash(plan, 'sleep 5', workspace, undefined, 100, network)).rejects.toMatchObject({
      message: 'Bash 命令执行超时。',
    });
    expect(network.close).toHaveBeenCalledOnce();
    expect(await readdir(calls)).toEqual([]);
  });

  it('代理不可用时计划拒绝全部网络，不存在直连退路', async () => {
    // 与 BashTool 的准备流程一致：代理启动失败时只传 undefined，计划不得放行任何网络。
    const unavailable = await startSandboxNetwork(sandbox({ networkAllow: ['registry.npmjs.org'] }), {
      startProxy: async () => { throw new Error('listen failed'); },
    });
    expect(unavailable).toBeUndefined();

    const plan = await sandboxPlan(planOptions({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
      ...(unavailable === undefined ? {} : { proxyPort: unavailable.port }),
    }));
    const lines = plan.profile.split('\n');
    expect(lines).toContain('(deny network*)');
    expect(lines.some((line) => line.startsWith('(allow network'))).toBe(false);
    expect(plan.proxy).toBeUndefined();
    expect(plan.env.HTTPS_PROXY).toBeUndefined();
    expect(plan.env.HTTP_PROXY).toBeUndefined();
  });
});