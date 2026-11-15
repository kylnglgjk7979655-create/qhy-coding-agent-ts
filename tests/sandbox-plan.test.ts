import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { SandboxConfig } from '../src/services/settings/config.js';
import { cleanupSandboxPlan, createSandboxPlan } from '../src/services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../src/services/sandbox/sandbox-plan.js';

let root: string;
let workspace: string;
let home: string;
let tmp: string;
let calls: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-plan-')));
  workspace = join(root, 'workspace');
  home = join(root, 'home');
  tmp = join(root, 'tmp');
  calls = join(root, 'calls');
  await Promise.all([mkdir(workspace), mkdir(home), mkdir(tmp), mkdir(calls)]);
  await mkdir(join(workspace, '.agent'), { recursive: true });
  await mkdir(join(workspace, '.claude', 'skills'), { recursive: true });
  await mkdir(join(workspace, '.git', 'hooks'), { recursive: true });
  await mkdir(join(workspace, '.github', 'workflows'), { recursive: true });
  await writeFile(join(workspace, '.agent', 'settings.json'), '{}');
  await writeFile(join(workspace, '.claude', 'settings.json'), '{}');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'authorized_keys'), 'key');
  await mkdir(join(home, 'read-denied'), { recursive: true });
  await mkdir(join(home, 'write-extra'), { recursive: true });
  await mkdir(join(home, 'write-allowed'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sandbox(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...DEFAULT_SANDBOX, enabled: true, ...overrides };
}

interface Options {
  config?: SandboxConfig;
  command?: string;
  disableSandbox?: boolean;
  seatbelt?: boolean;
  proxyPort?: number;
  env?: NodeJS.ProcessEnv;
}

function options(settings: Options = {}): Parameters<typeof createSandboxPlan>[0] {
  return {
    config: settings.config ?? sandbox(),
    workspace,
    input: {
      command: settings.command ?? 'echo ok',
      ...(settings.disableSandbox === undefined ? {} : { disableSandbox: settings.disableSandbox }),
    },
    platform: { seatbelt: settings.seatbelt ?? true },
    env: settings.env ?? { HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin' },
    ...(settings.proxyPort === undefined ? {} : { proxyPort: settings.proxyPort }),
    tempRoot: calls,
  };
}

async function profileLines(plan: SandboxPlan): Promise<string[]> {
  if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
  return plan.profile.split('\n');
}

describe('sandbox plan decision table', () => {
  it('沙箱关闭时不进沙箱，且忽略 disableSandbox，不生成临时目录', async () => {
    const plan = await createSandboxPlan(options({
      config: { ...DEFAULT_SANDBOX }, disableSandbox: true,
    }));
    expect(plan).toMatchObject({
      mode: 'host', sandboxed: false, reason: 'disabled', bypassRequested: true,
    });
    expect(plan).not.toHaveProperty('tempDir');
    expect(await readdir(calls)).toEqual([]);
  });

  it('沙箱不可用且 fail-open 时照常执行并提示未隔离', async () => {
    const plan = await createSandboxPlan(options({ seatbelt: false }));
    expect(plan).toMatchObject({ mode: 'host', sandboxed: false, reason: 'unavailable' });
    expect(plan.notice).toContain('未隔离');
    expect(await readdir(calls)).toEqual([]);
  });

  it('沙箱不可用且 fail-closed 时拒绝执行', async () => {
    const plan = await createSandboxPlan(options({
      seatbelt: false, config: sandbox({ onUnavailable: 'closed' }),
    }));
    expect(plan).toMatchObject({ mode: 'reject', sandboxed: false, reason: 'unavailable' });
    expect(plan.notice).toBeTruthy();
    expect(await readdir(calls)).toEqual([]);
  });

  it('沙箱可用且未申请豁免时进入沙箱', async () => {
    const plan = await createSandboxPlan(options());
    expect(plan).toMatchObject({
      mode: 'sandbox', sandboxed: true, reason: 'sandboxed', bypassRequested: false,
    });
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    const directory = await stat(plan.tempDir);
    expect(directory.isDirectory()).toBe(true);
    expect(directory.mode & 0o777).toBe(0o700);
    await cleanupSandboxPlan(plan);
  });

  it('整条命令全部命中排除表时豁免获准并在沙箱外执行', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({ bypassAllowedCommands: ['git push:*', 'npm test'] }),
      command: 'git push origin main && npm test',
      disableSandbox: true,
    }));
    expect(plan).toMatchObject({
      mode: 'host', sandboxed: false, reason: 'bypass-approved', bypassRequested: true,
    });
    expect(await readdir(calls)).toEqual([]);
  });

  it('任一简单命令未命中排除表时豁免未获准，仍强制进沙箱并注明', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({ bypassAllowedCommands: ['git push:*'] }),
      command: 'git push origin main && rm -rf dist',
      disableSandbox: true,
    }));
    expect(plan).toMatchObject({
      mode: 'sandbox', sandboxed: true, reason: 'bypass-denied', bypassRequested: true,
    });
    expect(plan.notice).toContain('豁免未获准');
    await cleanupSandboxPlan(plan);
  });

  it('排除表为空时豁免申请不会获准', async () => {
    const plan = await createSandboxPlan(options({ disableSandbox: true }));
    expect(plan).toMatchObject({ mode: 'sandbox', reason: 'bypass-denied', sandboxed: true });
    await cleanupSandboxPlan(plan);
  });

  it('同一输入产生相同决策、原因与环境，仅本次临时目录不同', async () => {
    const first = await createSandboxPlan(options());
    const second = await createSandboxPlan(options());
    expect(second.mode).toBe(first.mode);
    expect(second.reason).toBe(first.reason);
    expect(second.sandboxed).toBe(first.sandboxed);
    if (first.mode !== 'sandbox' || second.mode !== 'sandbox') throw new Error('expected sandboxed plans');
    expect(second.env).toEqual(first.env);
    expect(second.proxy).toEqual(first.proxy);
    expect(second.profile.replace(second.tempDir, '<call>')).toBe(first.profile.replace(first.tempDir, '<call>'));
    await cleanupSandboxPlan(first);
    await cleanupSandboxPlan(second);
  });
});

describe('sandbox profile', () => {
  it('按最后匹配者生效的顺序生成规则', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({
        writePaths: [join(home, 'write-allowed')],
        writeDenyPaths: [join(home, 'write-extra')],
        readDenyPaths: [join(home, 'read-denied')],
        readAllowPaths: [join(home, '.ssh', 'authorized_keys')],
      }),
    }));
    const lines = await profileLines(plan);
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');

    const readDeny = lines.findIndex((line) => line.startsWith('(deny file-read*'));
    const readAllow = lines.findIndex((line) => line.startsWith('(allow file-read*'));
    const writeDenyAll = lines.indexOf('(deny file-write*)');
    const writeAllow = lines.findIndex((line) => line.startsWith('(allow file-write*'));
    const writeDeny = lines.findIndex((line, index) =>
      index > writeAllow && line.startsWith('(deny file-write*'));
    const networkDeny = lines.indexOf('(deny network*)');

    expect(readDeny).toBeGreaterThan(1);
    expect(readAllow).toBeGreaterThan(readDeny);
    expect(writeDenyAll).toBeGreaterThan(readAllow);
    expect(writeAllow).toBeGreaterThan(writeDenyAll);
    expect(writeDeny).toBeGreaterThan(writeAllow);
    expect(networkDeny).toBeGreaterThan(writeDeny);
    expect(lines.some((line) => line.startsWith('(allow network'))).toBe(false);

    expect(lines[readDeny]).toContain(join(home, '.ssh'));
    expect(lines[readDeny]).toContain(join(home, 'read-denied'));
    expect(lines[readAllow]).toContain(join(home, '.ssh', 'authorized_keys'));
    expect(lines[writeAllow]).toContain(workspace);
    expect(lines[writeAllow]).toContain(tmp);
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    expect(lines[writeAllow]).toContain(plan.tempDir);
    expect(lines[writeAllow]).toContain(join(home, 'write-allowed'));
    expect(lines[writeDeny]).toContain(join(home, 'write-extra'));
    await cleanupSandboxPlan(plan);
  });

  it('内置防篡改写拒绝始终保留，用户写允许不能覆盖写拒绝', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({
        writePaths: [join(workspace, '.agent', 'settings.json')],
        writeDenyPaths: [join(home, 'write-extra')],
      }),
    }));
    const lines = await profileLines(plan);
    const writeAllow = lines.findIndex((line) => line.startsWith('(allow file-write*'));
    const writeDenyLines = lines.filter((line, index) =>
      index > writeAllow && line.startsWith('(deny file-write*'));
    expect(writeDenyLines.join('\n')).toContain(join(workspace, '.agent', 'settings.json'));
    expect(writeDenyLines.join('\n')).toContain(join(workspace, '.claude', 'skills'));
    expect(writeDenyLines.join('\n')).toContain(join(workspace, '.git', 'hooks'));
    expect(writeDenyLines.join('\n')).toContain(join(workspace, '.github', 'workflows'));
    expect(writeDenyLines.join('\n')).toContain(join(home, 'write-extra'));
    await cleanupSandboxPlan(plan);
  });

  it('路径先解析真实路径，不存在的路径被跳过', async () => {
    const realTarget = join(home, 'write-allowed');
    const link = join(root, 'write-link');
    await symlink(realTarget, link);
    const missing = join(root, 'missing');
    const plan = await createSandboxPlan(options({
      config: sandbox({
        writePaths: [link, missing],
        readDenyPaths: [missing],
        readAllowPaths: [join(home, '.ssh', 'not-there')],
      }),
    }));
    const lines = await profileLines(plan);
    const text = lines.join('\n');
    expect(text).toContain(realTarget);
    expect(text).not.toContain(link);
    expect(text).not.toContain(missing);
    expect(lines.some((line) => line.startsWith('(allow file-read*'))).toBe(false);
    // 未创建的内置敏感路径也跳过，已创建的内置路径保留。
    expect(text).toContain(join(home, '.ssh'));
    expect(text).not.toContain(join(home, '.aws'));
    await cleanupSandboxPlan(plan);
  });

  it('内置写拒绝覆盖尚不存在的防篡改目标，不能靠先创建再写入绕过', async () => {
    // .agent/settings.local.json、.claude/settings.local.json、.agents/skills 在计划生成时都不存在；
    // 只有保留这些规则，沙箱内才不能先创建配置文件再借配置提权。
    const plan = await createSandboxPlan(options({
      config: sandbox({ writePaths: [join(workspace, '.agent', 'settings.local.json')] }),
    }));
    const lines = await profileLines(plan);
    const writeAllow = lines.findIndex((line) => line.startsWith('(allow file-write*'));
    const writeDeny = lines.find((line, index) => index > writeAllow && line.startsWith('(deny file-write*'));
    expect(writeDeny).toContain(join(workspace, '.agent', 'settings.local.json'));
    expect(writeDeny).toContain(join(workspace, '.claude', 'settings.local.json'));
    expect(writeDeny).toContain(join(workspace, '.agents', 'skills'));
    await cleanupSandboxPlan(plan);
  });

  it('不存在的写拒绝目标按最近已存在祖先解析真实路径', async () => {
    const realTarget = join(home, 'write-extra');
    const link = join(workspace, 'extra-link');
    await symlink(realTarget, link);
    const plan = await createSandboxPlan(options({
      config: sandbox({ writeDenyPaths: [join(link, 'later.txt')] }),
    }));
    const text = (await profileLines(plan)).join('\n');
    expect(text).toContain(join(realTarget, 'later.txt'));
    expect(text).not.toContain(join(link, 'later.txt'));
    await cleanupSandboxPlan(plan);
  });

  it('每次调用创建不同的临时目录，清理后不残留且跨调用不共享数据', async () => {
    const first = await createSandboxPlan(options());
    const second = await createSandboxPlan(options());
    if (first.mode !== 'sandbox' || second.mode !== 'sandbox') throw new Error('expected sandboxed plans');
    expect(second.tempDir).not.toBe(first.tempDir);
    await writeFile(join(first.tempDir, 'marker'), 'first-call');
    await expect(readdir(second.tempDir)).resolves.toEqual([]);

    await cleanupSandboxPlan(first);
    await expect(stat(first.tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await cleanupSandboxPlan(second);
    expect(await readdir(calls)).toEqual([]);
  });

  it('读拒绝同样按真实路径匹配，符号链接不能换成未解析路径', async () => {
    const link = join(root, 'ssh-link');
    await symlink(join(home, '.ssh'), link);
    const plan = await createSandboxPlan(options({
      config: sandbox({ readDenyPaths: [link] }),
    }));
    const lines = await profileLines(plan);
    const readDeny = lines.find((line) => line.startsWith('(deny file-read*'));
    expect(readDeny).toContain(join(home, '.ssh'));
    expect(readDeny).not.toContain(link);
    await cleanupSandboxPlan(plan);
  });

  it('代理关闭时不生成本机放行规则，也不注入代理变量', async () => {
    const plan = await createSandboxPlan(options());
    const lines = await profileLines(plan);
    expect(lines.some((line) => line.startsWith('(allow network'))).toBe(false);
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    expect(plan.proxy).toBeUndefined();
    expect(plan.env.HTTP_PROXY).toBeUndefined();
    expect(plan.env.HTTPS_PROXY).toBeUndefined();
    await cleanupSandboxPlan(plan);
  });

  it('配置了域名但代理未启动时仍拒绝全部网络', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({ networkAllow: ['registry.npmjs.org'] }),
    }));
    const lines = await profileLines(plan);
    expect(lines.includes('(deny network*)')).toBe(true);
    expect(lines.some((line) => line.startsWith('(allow network'))).toBe(false);
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    expect(plan.proxy).toBeUndefined();
    expect(plan.env.HTTPS_PROXY).toBeUndefined();
    await cleanupSandboxPlan(plan);
  });

  it('代理开启时仅放行本机代理端口并注入代理变量', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({ networkAllow: ['registry.npmjs.org', '*.example.com'], networkPorts: [443, 8443] }),
      proxyPort: 4567,
    }));
    const lines = await profileLines(plan);
    const networkDeny = lines.indexOf('(deny network*)');
    const networkAllow = lines.findIndex((line) => line.startsWith('(allow network'));
    expect(networkAllow).toBeGreaterThan(networkDeny);
    expect(lines[networkAllow]).toContain('localhost:4567');
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    expect(plan.proxy).toMatchObject({
      port: 4567,
      allowedHosts: ['registry.npmjs.org', '*.example.com'],
      allowedPorts: [443, 8443],
    });
    for (const name of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
      'ALL_PROXY', 'all_proxy', 'GRPC_PROXY', 'grpc_proxy',
    ]) {
      expect(plan.env[name]).toBe('http://localhost:4567');
    }
    await cleanupSandboxPlan(plan);
  });
});

describe('sandbox child environment', () => {
  it('只保留最小集合、代理变量与 envPassthrough', async () => {
    const plan = await createSandboxPlan(options({
      config: sandbox({ envPassthrough: ['PASSTHROUGH', 'NOT_SET'] }),
      env: {
        HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C',
        TERM: 'xterm', SHELL: '/bin/bash', USER: 'tester', LOGNAME: 'tester', TZ: 'UTC',
        OPENAI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'cloud-secret', PASSTHROUGH: 'visible',
      },
    }));
    if (plan.mode !== 'sandbox') throw new Error('expected sandboxed plan');
    expect(plan.env).toEqual({
      HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C',
      TERM: 'xterm', SHELL: '/bin/bash', USER: 'tester', LOGNAME: 'tester', TZ: 'UTC',
      PASSTHROUGH: 'visible',
    });
    expect(JSON.stringify(plan.env)).not.toContain('secret');
    await cleanupSandboxPlan(plan);
  });

  it('进入沙箱外的分支不携带受限环境', async () => {
    const disabled = await createSandboxPlan(options({ config: { ...DEFAULT_SANDBOX }, env: { SECRET: 'x' } }));
    expect(disabled).not.toHaveProperty('env');
    const unavailable = await createSandboxPlan(options({ seatbelt: false, env: { SECRET: 'x' } }));
    expect(unavailable).not.toHaveProperty('env');
  });
});