import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeBashCommand, matchesCommandPattern } from '../../tools/BashTool/bash-policy.js';
import type { SandboxConfig } from '../settings/config.js';

/** 平台探测结果由进程内一次自检得出；不在策略模块内重复探测。 */
export interface SandboxPlatformProbe {
  /** macOS 上 sandbox-exec 可执行，且最小 profile 能成功运行。 */
  seatbelt: boolean;
}

export interface SandboxBashInput {
  command: string;
  /** 模型申请在沙箱外执行；仅在沙箱可用且全部简单命令命中排除表时获准。 */
  disableSandbox?: boolean;
}

export interface CreateSandboxPlanOptions {
  config: SandboxConfig;
  workspace: string;
  input: SandboxBashInput;
  platform: SandboxPlatformProbe;
  env: NodeJS.ProcessEnv;
  /** 已启动代理的本地端口；缺省表示代理不可用，本次沙箱调用没有网络。 */
  proxyPort?: number;
  /** 解析 `~` 时使用的家目录，默认取 env.HOME。 */
  home?: string;
  /** 本次调用临时目录的父目录，默认取系统临时目录。 */
  tempRoot?: string;
}

export type SandboxPlanReason = 'disabled' | 'unavailable' | 'sandboxed' | 'bypass-approved' | 'bypass-denied';

/** 沙箱网络策略；代理实例由执行层按此配置启动。 */
export interface SandboxProxyPlan {
  port: number;
  allowedHosts: string[];
  allowedPorts: number[];
}

interface SandboxPlanCommon {
  sandboxed: boolean;
  reason: SandboxPlanReason;
  bypassRequested: boolean;
  /** 供工具结果与审批展示的说明；具体措辞由消费方决定如何呈现。 */
  notice?: string;
}

export interface SandboxHostPlan extends SandboxPlanCommon {
  mode: 'host';
  sandboxed: false;
  reason: 'disabled' | 'unavailable' | 'bypass-approved';
}

export interface SandboxRejectedPlan extends SandboxPlanCommon {
  mode: 'reject';
  sandboxed: false;
  reason: 'unavailable';
}

export interface SandboxIsolatedPlan extends SandboxPlanCommon {
  mode: 'sandbox';
  sandboxed: true;
  reason: 'sandboxed' | 'bypass-denied';
  /** 按最后匹配者生效顺序排列的 Seatbelt profile。 */
  profile: string;
  /** 子进程仅继承最小集合、代理变量与 envPassthrough。 */
  env: Record<string, string>;
  /** 本次调用独立的 0700 临时目录，调用结束后由执行层清理。 */
  tempDir: string;
  proxy?: SandboxProxyPlan;
}

export type SandboxPlan = SandboxHostPlan | SandboxRejectedPlan | SandboxIsolatedPlan;

/** 沙箱内仍默认允许读取，但内置敏感路径在用户没有精确打洞时保持拒读。 */
export const BUILT_IN_READ_DENY_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.kube',
  '~/.azure',
  '~/.git-credentials',
  '~/.netrc',
  '~/.npmrc',
  '~/.password-store',
  '~/.config/gh',
  '~/.config/gcloud',
  '~/.docker/config.json',
  '~/Library/Keychains',
  '~/.local/share/keyrings',
  '~/Documents',
  '~/Desktop',
  '~/Downloads',
  '~/Library/Messages',
  '~/Library/Mail',
  '~/Library/Safari',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/.qhy-coding-agents',
] as const;

/** 内置防篡改路径只能追加，用户配置无法删除或提前覆盖。 */
export const BUILT_IN_WRITE_DENY_PATHS = [
  '.agent/settings.json',
  '.agent/settings.local.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills/**',
  '.agents/skills/**',
  '.git/hooks/**',
  '.git/config',
  '.github/workflows/**',
] as const;

const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'TZ'] as const;
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'GRPC_PROXY', 'grpc_proxy',
] as const;

/**
 * 生成一次 Bash 调用唯一的沙箱执行计划。
 * 执行层与审批只消费该结果，不重新推导执行模式、规则或环境。
 */
export async function createSandboxPlan(options: CreateSandboxPlanOptions): Promise<SandboxPlan> {
  const { config, input } = options;
  const bypassRequested = input.disableSandbox === true;
  if (!config.enabled) {
    return { mode: 'host', sandboxed: false, reason: 'disabled', bypassRequested };
  }
  if (!options.platform.seatbelt) {
    return config.onUnavailable === 'closed'
      ? {
        mode: 'reject', sandboxed: false, reason: 'unavailable', bypassRequested,
        notice: '沙箱不可用且配置为 onUnavailable: "closed"，已拒绝执行。',
      }
      : {
        mode: 'host', sandboxed: false, reason: 'unavailable', bypassRequested,
        notice: '沙箱不可用，本次命令未隔离执行（onUnavailable: "open"）。',
      };
  }
  if (bypassRequested && bypassGranted(config.bypassAllowedCommands, input.command)) {
    return {
      mode: 'host', sandboxed: false, reason: 'bypass-approved', bypassRequested,
      notice: '豁免获准：整条命令命中 bypassAllowedCommands，将在沙箱外执行。',
    };
  }

  const home = options.home ?? options.env.HOME ?? homedir();
  const proxy = resolveProxy(config, options.proxyPort);
  const tempDir = await createTempDir(options.tempRoot);
  try {
    const canonicalTempDir = await existingRealPath(tempDir) ?? tempDir;
    const readDeny = await canonicalPaths([
      ...BUILT_IN_READ_DENY_PATHS.map((path) => resolve(join(home, path.slice(2)))),
      ...config.readDenyPaths.map((path) => resolveConfiguredPath(options.workspace, home, path)),
    ]);
    const readAllow = await canonicalPaths(
      config.readAllowPaths.map((path) => resolveConfiguredPath(options.workspace, home, path)),
    );
    const writeAllow = await canonicalPaths([
      options.workspace,
      ...(options.env.TMPDIR === undefined ? [] : [options.env.TMPDIR]),
      canonicalTempDir,
      ...config.writePaths.map((path) => resolveConfiguredPath(options.workspace, home, path)),
    ]);
    const writeDeny = await canonicalPaths([
      ...BUILT_IN_WRITE_DENY_PATHS.map((path) => resolve(options.workspace, stripGlobSuffix(path))),
      ...config.writeDenyPaths.map((path) => resolveConfiguredPath(options.workspace, home, path)),
    ]);
    const profile = renderProfile({ readDeny, readAllow, writeAllow, writeDeny, proxy });
    const env = buildEnvironment(options.env, config.envPassthrough, proxy);
    return {
      mode: 'sandbox', sandboxed: true,
      reason: bypassRequested ? 'bypass-denied' : 'sandboxed',
      bypassRequested,
      ...(bypassRequested
        ? { notice: '豁免未获准：存在未命中 bypassAllowedCommands 的简单命令，已在沙箱内执行。' }
        : {}),
      profile, env, tempDir: canonicalTempDir,
      ...(proxy === undefined ? {} : { proxy }),
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** 清理沙箱调用结束后遗留的临时目录；未进入沙箱的计划没有临时目录。 */
export async function cleanupSandboxPlan(plan: SandboxPlan): Promise<void> {
  if (plan.mode === 'sandbox') await rm(plan.tempDir, { recursive: true, force: true });
}

function bypassGranted(patterns: readonly string[], command: string): boolean {
  if (patterns.length === 0) return false;
  let commands: string[];
  try {
    commands = analyzeBashCommand(command).commands;
  } catch {
    // 无法逐条识别的命令不可能“全部命中”，保守地留在沙箱内。
    return false;
  }
  return commands.length > 0 && commands.every((item) => patterns.some((pattern) => matchesCommandPattern(pattern, item)));
}

function resolveProxy(config: SandboxConfig, proxyPort: number | undefined): SandboxProxyPlan | undefined {
  if (config.networkAllow.length === 0) return undefined;
  // 代理没有启动时本次调用只保留全局网络拒绝，绝不退回直连。
  if (proxyPort === undefined) return undefined;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) {
    throw new Error('沙箱网络代理端口无效。');
  }
  return {
    port: proxyPort,
    allowedHosts: [...config.networkAllow],
    allowedPorts: [...config.networkPorts],
  };
}

function resolveConfiguredPath(workspace: string, home: string, path: string): string {
  if (path === '~') return resolve(home);
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return resolve(workspace, path);
}

/** 目录通配只用于表达整棵子树；解析真实路径时去掉通配后缀，以 subpath 覆盖。 */
function stripGlobSuffix(path: string): string {
  return path.endsWith('/**') ? path.slice(0, -3) : path;
}

async function createTempDir(tempRoot: string | undefined): Promise<string> {
  const directory = await mkdtemp(join(tempRoot ?? tmpdir(), 'qhy-sandbox-'));
  // mkdtemp 的 0700 仍受 umask 影响，显式收紧，确保其他用户无法进入调用目录。
  await chmod(directory, 0o700);
  return directory;
}

async function existingRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** 解析真实路径、跳过不存在项并按首次出现顺序去重。 */
async function canonicalPaths(paths: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    const canonical = await existingRealPath(path);
    if (canonical !== undefined && !result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function buildEnvironment(
  source: NodeJS.ProcessEnv,
  passthrough: readonly string[],
  proxy: SandboxProxyPlan | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...MINIMAL_ENV_KEYS, ...passthrough]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (proxy !== undefined) {
    for (const key of PROXY_ENV_KEYS) env[key] = `http://localhost:${proxy.port}`;
  }
  return env;
}

interface ProfileRules {
  readDeny: readonly string[];
  readAllow: readonly string[];
  writeAllow: readonly string[];
  writeDeny: readonly string[];
  proxy: SandboxProxyPlan | undefined;
}

/** 规则顺序即 Seatbelt 的后匹配优先顺序；调用方不得重排。 */
function renderProfile({ readDeny, readAllow, writeAllow, writeDeny, proxy }: ProfileRules): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    subpathRule('deny', 'file-read*', readDeny),
    subpathRule('allow', 'file-read*', readAllow),
    '(deny file-write*)',
    subpathRule('allow', 'file-write*', writeAllow),
    subpathRule('deny', 'file-write*', writeDeny),
    '(deny network*)',
    ...(proxy === undefined ? [] : [`(allow network-outbound (remote ip "localhost:${proxy.port}"))`]),
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function subpathRule(action: 'allow' | 'deny', operation: string, paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const filters = paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ');
  return `(${action} ${operation} ${filters})`;
}