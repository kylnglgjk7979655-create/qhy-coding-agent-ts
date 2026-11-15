import { startNetworkProxy } from './network-proxy.js';
import type {
  NetworkProxy,
  NetworkProxyOptions,
  OpenTunnel,
  ProxyViolation,
  ProxyViolationReason,
  ResolveHost,
} from './network-proxy.js';
import type { SandboxConfig } from '../settings/config.js';

/** 一次沙箱调用独有的代理会话；执行层只读取违规并在调用结束时关闭。 */
export type SandboxNetwork = NetworkProxy;

/** 代理实现与解析、连接依赖可注入，便于用本地假上游验证公开契约。 */
export interface SandboxNetworkDependencies {
  startProxy?: (options: NetworkProxyOptions) => Promise<NetworkProxy>;
  resolveHost?: ResolveHost;
  openTunnel?: OpenTunnel;
  now?: () => number;
}

/**
 * 仅为已启用且域名白名单非空的沙箱调用启动本机代理。
 * 启动失败表示本次调用没有网络，调用方只能生成拒绝全部网络的计划，不得退回直连。
 * 调用方负责在审批拒绝或执行结束后关闭代理。
 */
export async function startSandboxNetwork(
  config: SandboxConfig,
  dependencies: SandboxNetworkDependencies = {},
): Promise<SandboxNetwork | undefined> {
  if (!config.enabled || config.networkAllow.length === 0) return undefined;
  const startProxy = dependencies.startProxy ?? startNetworkProxy;
  try {
    return await startProxy({
      allowedHosts: [...config.networkAllow],
      allowedPorts: [...config.networkPorts],
      ...(dependencies.resolveHost === undefined ? {} : { resolveHost: dependencies.resolveHost }),
      ...(dependencies.openTunnel === undefined ? {} : { openTunnel: dependencies.openTunnel }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  } catch {
    return undefined;
  }
}

const VIOLATION_REASON_TEXT: Record<ProxyViolationReason, string> = {
  'invalid-target': '目标格式无效',
  'port-not-allowed': '端口不在白名单',
  'host-not-allowed': '域名不在白名单',
  'dns-failed': '域名解析失败',
  'dangerous-address': '目标解析到受限地址',
};

/**
 * 把本次调用累计的代理拒绝汇总为带标签的文本，供执行层附加到命令输出。
 * 同时保留稳定的原因码，模型据此区分网络策略拒绝与命令自身错误。
 */
export function formatSandboxViolations(violations: readonly ProxyViolation[]): string | undefined {
  if (violations.length === 0) return undefined;
  return [
    '<sandbox_violations>',
    '沙箱网络代理拒绝了以下目标：',
    ...violations.map(({ host, port, reason }) => `- ${host}:${port} ${VIOLATION_REASON_TEXT[reason]}（${reason}）`),
    '</sandbox_violations>',
  ].join('\n');
}
