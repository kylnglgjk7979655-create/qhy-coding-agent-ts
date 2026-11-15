import { once } from 'node:events';
import { createServer as createNetServer, connect as connectNet } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { SandboxConfig } from '../src/services/settings/config.js';
import type { NetworkProxy, NetworkProxyOptions } from '../src/services/sandbox/network-proxy.js';
import { startSandboxNetwork } from '../src/services/sandbox/sandbox-network.js';

const NOW = 1_700_000_000_000;

interface FakeUpstream {
  port: number;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 沙箱配置默认开启，只覆盖与网络相关的字段。 */
function sandbox(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...DEFAULT_SANDBOX, enabled: true, networkAllow: ['registry.npmjs.org'], ...overrides };
}

/** 本地假上游：回显收到的字节，验证代理隧道只透传不解密。 */
async function startFakeUpstream(): Promise<FakeUpstream> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('data', (chunk) => { socket.write(Buffer.concat([Buffer.from('echo:'), chunk])); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tunnelOpener(upstream: FakeUpstream) {
  return async (): Promise<Socket> => {
    const socket = connectNet({ host: '127.0.0.1', port: upstream.port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  };
}

async function sendConnect(port: number, target: string): Promise<{ socket: Socket; text: string }> {
  const socket = connectNet({ host: 'localhost', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let received = Buffer.alloc(0);
  while (!received.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    received = Buffer.concat([received, chunk]);
  }
  return { socket, text: received.toString('latin1') };
}

function statusLine(text: string): string {
  return text.split('\r\n', 1)[0] ?? '';
}

describe('沙箱网络代理开关', () => {
  it('白名单为空时不启动代理', async () => {
    const startProxy = vi.fn();
    const network = await startSandboxNetwork(sandbox({ networkAllow: [] }), { startProxy });
    expect(network).toBeUndefined();
    expect(startProxy).not.toHaveBeenCalled();
  });

  it('沙箱关闭时即使配置了白名单也不启动代理', async () => {
    const startProxy = vi.fn();
    const network = await startSandboxNetwork(sandbox({ enabled: false }), { startProxy });
    expect(network).toBeUndefined();
    expect(startProxy).not.toHaveBeenCalled();
  });

  it('白名单非空时按配置启动独立代理并暴露关闭', async () => {
    const close = vi.fn(async () => {});
    const startProxy = vi.fn(async (_options: NetworkProxyOptions): Promise<NetworkProxy> => ({
      port: 4567,
      violations: [],
      close,
    }));

    const network = await startSandboxNetwork(
      sandbox({ networkAllow: ['registry.npmjs.org', '*.example.com'], networkPorts: [443, 8443] }),
      { startProxy },
    );

    expect(startProxy).toHaveBeenCalledOnce();
    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      allowedHosts: ['registry.npmjs.org', '*.example.com'],
      allowedPorts: [443, 8443],
    }));
    expect(network?.port).toBe(4567);
    await network?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('代理启动失败时返回 undefined，不向调用方抛出', async () => {
    const network = await startSandboxNetwork(sandbox(), {
      startProxy: async () => { throw new Error('listen failed'); },
    });
    expect(network).toBeUndefined();
  });
});

describe('接入后的端口与域名策略', () => {
  it('放行白名单域名与端口，拒绝白名单外目标、非白名单端口与危险地址', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const network = await startSandboxNetwork(
      sandbox({ networkAllow: ['*.example.com'], networkPorts: [upstream.port] }),
      {
        // 只放行 *.example.com；danger.example.com 被解析到回环地址。
        resolveHost: async (host) => (host === 'danger.example.com' ? ['127.0.0.1'] : ['93.184.216.34']),
        openTunnel: tunnelOpener(upstream),
        now: () => NOW,
      },
    );
    expect(network).toBeDefined();
    cleanups.push(async () => { await network?.close(); });

    const allowed = await sendConnect(network!.port, `api.example.com:${upstream.port}`);
    expect(statusLine(allowed.text)).toContain('200');
    // 代理只透传原始字节，不终结 TLS。
    const payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2f, 0x41]);
    allowed.socket.write(payload);
    const [reply] = await once(allowed.socket, 'data') as [Buffer];
    expect(reply).toEqual(Buffer.concat([Buffer.from('echo:'), payload]));
    allowed.socket.destroy();

    for (const target of [
      `outside.test:${upstream.port}`,
      `api.example.com:${upstream.port + 1}`,
      `danger.example.com:${upstream.port}`,
    ]) {
      const rejected = await sendConnect(network!.port, target);
      expect(statusLine(rejected.text)).toContain('403');
      rejected.socket.destroy();
    }
    expect(network!.violations).toEqual([
      { host: 'outside.test', port: upstream.port, reason: 'host-not-allowed', timestamp: NOW },
      { host: 'api.example.com', port: upstream.port + 1, reason: 'port-not-allowed', timestamp: NOW },
      { host: 'danger.example.com', port: upstream.port, reason: 'dangerous-address', timestamp: NOW },
    ]);
  });

  it('关闭后释放监听端口', async () => {
    const network = await startSandboxNetwork(sandbox());
    expect(network).toBeDefined();

    await network!.close();

    await expect(new Promise<void>((resolve, reject) => {
      const attempt = connectNet({ host: 'localhost', port: network!.port });
      attempt.once('connect', () => { attempt.destroy(); reject(new Error('端口仍在监听')); });
      attempt.once('error', () => { resolve(); });
    })).resolves.toBeUndefined();
  });
});