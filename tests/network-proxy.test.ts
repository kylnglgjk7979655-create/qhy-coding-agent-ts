import { once } from 'node:events';
import { createServer as createNetServer, connect as connectNet } from 'node:net';
import { PassThrough } from 'node:stream';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNetworkProxy } from '../src/services/sandbox/network-proxy.js';
import type { NetworkProxy, NetworkProxyOptions } from '../src/services/sandbox/network-proxy.js';

const NOW = 1_700_000_000_000;

interface FakeUpstream {
  port: number;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 本地假上游：原样回显收到的字节，验证代理只是透传隧道而不终结 TLS。 */
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

async function startProxy(overrides: Partial<NetworkProxyOptions> = {}): Promise<NetworkProxy> {
  const proxy = await startNetworkProxy({
    allowedHosts: ['registry.npmjs.org'],
    allowedPorts: [443],
    resolveHost: async () => ['93.184.216.34'],
    openTunnel: async () => { throw new Error('测试不应建立上游连接'); },
    now: () => NOW,
    ...overrides,
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

async function sendRaw(proxy: NetworkProxy, request: string): Promise<{ socket: Socket; text: string }> {
  const socket = connectNet({ host: 'localhost', port: proxy.port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(request);
  let received = Buffer.alloc(0);
  while (!received.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    received = Buffer.concat([received, chunk]);
  }
  return { socket, text: received.toString('latin1') };
}

function connectRequest(target: string): string {
  return `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
}

function statusLine(text: string): string {
  return text.split('\r\n', 1)[0] ?? '';
}

function tunnelOpener(upstream: FakeUpstream) {
  return async (): Promise<Socket> => {
    const socket = connectNet({ host: '127.0.0.1', port: upstream.port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  };
}

describe('CONNECT 代理请求入口', () => {
  it('只接受 CONNECT，其他方法返回 405', async () => {
    const proxy = await startProxy();
    for (const request of [
      'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n',
      'POST /upload HTTP/1.1\r\nHost: example.com\r\nContent-Length: 0\r\n\r\n',
    ]) {
      const { socket, text } = await sendRaw(proxy, request);
      expect(statusLine(text)).toContain('405');
      socket.destroy();
    }
    expect(proxy.violations).toEqual([]);
  });

  it('绑定随机本机端口', async () => {
    const proxy = await startProxy();
    expect(Number.isInteger(proxy.port)).toBe(true);
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.port).toBeLessThanOrEqual(65_535);
  });

  it('缺少端口的 CONNECT 目标返回 403 并记录非法目标', async () => {
    const proxy = await startProxy();
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([
      { host: 'registry.npmjs.org', port: 0, reason: 'invalid-target', timestamp: NOW },
    ]);
    socket.destroy();
  });
});

describe('目标校验顺序', () => {
  it('先校验端口：端口不在白名单时不再校验域名或解析 DNS', async () => {
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const openTunnel = vi.fn(async () => { throw new Error('不应连接'); });
    const proxy = await startProxy({ resolveHost, openTunnel });
    const { socket, text } = await sendRaw(proxy, connectRequest('evil.example:8443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ host: 'evil.example', port: 8443, reason: 'port-not-allowed' }]);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('端口通过后校验域名：未命中白名单时不解析 DNS', async () => {
    const resolveHost = vi.fn(async () => ['93.184.216.34']);
    const proxy = await startProxy({ resolveHost });
    const { socket, text } = await sendRaw(proxy, connectRequest('evil.example:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ host: 'evil.example', port: 443, reason: 'host-not-allowed' }]);
    expect(resolveHost).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('域名通过后解析 DNS：解析失败按 403 拒绝', async () => {
    const resolveHost = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const openTunnel = vi.fn(async () => { throw new Error('不应连接'); });
    const proxy = await startProxy({ resolveHost, openTunnel });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ host: 'registry.npmjs.org', port: 443, reason: 'dns-failed' }]);
    expect(openTunnel).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('DNS 没有返回任何地址时按解析失败拒绝', async () => {
    const proxy = await startProxy({ resolveHost: async () => [] });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ reason: 'dns-failed' }]);
    socket.destroy();
  });

  it('显式 :80 端口不会被 WHATWG 默认端口归一化误判为非法目标', async () => {
    // http scheme 会把显式 :80 归一化为空端口，代理必须从原始 authority 取端口，否则 networkPorts: [80] 永不生效。
    const proxy = await startProxy({
      allowedPorts: [80],
      openTunnel: async () => new PassThrough(),
    });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:80'));
    expect(statusLine(text)).toContain('200');
    expect(proxy.violations).toEqual([]);
    socket.destroy();
  });

  it.each([
    ['127.0.0.1'],
    ['127.255.255.254'],
    ['::1'],
    ['::'],
    ['::127.0.0.1'],
    ['::7f00:1'],
    ['::a00:1'],
    ['10.0.0.1'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.0.1'],
    ['169.254.169.254'],
    ['100.100.100.200'],
    ['100.64.0.1'],
    ['fd00::1'],
    ['fe80::1'],
    ['::ffff:127.0.0.1'],
  ])('域名解析到危险地址 %s 时拒绝', async (address) => {
    const openTunnel = vi.fn(async () => { throw new Error('不应连接'); });
    const proxy = await startProxy({ resolveHost: async () => [address], openTunnel });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ host: 'registry.npmjs.org', port: 443, reason: 'dangerous-address' }]);
    expect(openTunnel).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('任一解析结果落入危险地址即拒绝，即使同时存在公网地址', async () => {
    const proxy = await startProxy({ resolveHost: async () => ['93.184.216.34', '10.0.0.1'] });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ reason: 'dangerous-address' }]);
    socket.destroy();
  });

  it.each([
    ['93.184.216.34'],
    ['172.15.255.255'],
    ['172.32.0.1'],
    ['192.167.255.255'],
    ['192.169.0.1'],
    ['169.253.255.255'],
    ['2606:4700:4700::1111'],
  ])('域名解析到公网地址 %s 时放行', async (address) => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy({
      allowedPorts: [443, upstream.port],
      resolveHost: async () => [address],
      openTunnel: tunnelOpener(upstream),
    });
    const { socket, text } = await sendRaw(proxy, connectRequest(`registry.npmjs.org:${upstream.port}`));
    expect(statusLine(text)).toContain('200');
    socket.destroy();
  });
});

describe('域名白名单匹配', () => {
  it('精确匹配区分完整域名，不做后缀或子串匹配', async () => {
    const proxy = await startProxy({ allowedHosts: ['registry.npmjs.org'] });
    const { socket, text } = await sendRaw(proxy, connectRequest('evil-registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('403');
    expect(proxy.violations).toMatchObject([{ reason: 'host-not-allowed' }]);
    socket.destroy();
  });

  it('域名匹配忽略大小写和结尾的点', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy({
      allowedHosts: ['Registry.NPMJS.org.'],
      allowedPorts: [upstream.port],
      openTunnel: tunnelOpener(upstream),
    });
    const { socket, text } = await sendRaw(proxy, connectRequest(`registry.npmjs.org:${upstream.port}`));
    expect(statusLine(text)).toContain('200');
    socket.destroy();
  });

  it('*. 子域匹配一层和多层子域，但不匹配裸域名或相邻域名', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy({
      allowedHosts: ['*.example.com'],
      allowedPorts: [upstream.port],
      openTunnel: tunnelOpener(upstream),
    });
    for (const host of ['api.example.com', 'deep.api.example.com']) {
      const { socket, text } = await sendRaw(proxy, connectRequest(`${host}:${upstream.port}`));
      expect(statusLine(text)).toContain('200');
      socket.destroy();
    }
    for (const host of ['example.com', 'badexample.com', 'example.com.evil.test']) {
      const { socket, text } = await sendRaw(proxy, connectRequest(`${host}:${upstream.port}`));
      expect(statusLine(text)).toContain('403');
      socket.destroy();
    }
    expect(proxy.violations).toEqual([
      expect.objectContaining({ host: 'example.com', reason: 'host-not-allowed' }),
      expect.objectContaining({ host: 'badexample.com', reason: 'host-not-allowed' }),
      expect.objectContaining({ host: 'example.com.evil.test', reason: 'host-not-allowed' }),
    ]);
  });
});

describe('允许目标建立隧道', () => {
  it('返回 200 并原样透传字节到本地假上游，不做 TLS 终结', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy({
      allowedPorts: [upstream.port],
      openTunnel: tunnelOpener(upstream),
    });
    const { socket, text } = await sendRaw(proxy, connectRequest(`registry.npmjs.org:${upstream.port}`));
    expect(statusLine(text)).toContain('200');
    // 0x16 0x03 0x01 是 TLS 握手记录的起始字节；代理必须原样转发，不能自行握手或插入证书。
    const payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2f, 0x41, 0x42]);
    socket.write(payload);
    const [reply] = await once(socket, 'data') as [Buffer];
    expect(reply).toEqual(Buffer.concat([Buffer.from('echo:'), payload]));
    socket.destroy();
  });

  it('按解析顺序尝试多个安全地址，首选不可达时继续连接后续地址', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const attempted: string[] = [];
    const proxy = await startProxy({
      allowedPorts: [upstream.port],
      resolveHost: async () => ['93.184.216.34', '2606:4700:4700::1111'],
      openTunnel: async ({ address }) => {
        attempted.push(address);
        if (address === '93.184.216.34') throw new Error('unreachable');
        return tunnelOpener(upstream)();
      },
    });
    const { socket, text } = await sendRaw(proxy, connectRequest(`registry.npmjs.org:${upstream.port}`));
    expect(statusLine(text)).toContain('200');
    expect(attempted).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
    socket.destroy();
  });

  it('上游连接失败时返回 502 且不记为策略违规', async () => {
    const proxy = await startProxy({
      openTunnel: async () => { throw new Error('ECONNREFUSED'); },
    });
    const { socket, text } = await sendRaw(proxy, connectRequest('registry.npmjs.org:443'));
    expect(statusLine(text)).toContain('502');
    expect(proxy.violations).toEqual([]);
    socket.destroy();
  });
});

describe('违规记录与关闭', () => {
  it('累计多次拒绝的目标、端口、原因和时间', async () => {
    const proxy = await startProxy({ allowedPorts: [443, 8443], allowedHosts: ['registry.npmjs.org', '*.example.com'] });
    for (const target of ['evil.example:443', 'registry.npmjs.org:8080', 'api.example.com:9999']) {
      const { socket } = await sendRaw(proxy, connectRequest(target));
      socket.destroy();
    }
    expect(proxy.violations).toEqual([
      { host: 'evil.example', port: 443, reason: 'host-not-allowed', timestamp: NOW },
      { host: 'registry.npmjs.org', port: 8080, reason: 'port-not-allowed', timestamp: NOW },
      { host: 'api.example.com', port: 9999, reason: 'port-not-allowed', timestamp: NOW },
    ]);
  });

  it('关闭代理终止活动隧道并释放监听端口', async () => {
    const upstream = await startFakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy({
      allowedPorts: [upstream.port],
      openTunnel: tunnelOpener(upstream),
    });
    const { socket, text } = await sendRaw(proxy, connectRequest(`registry.npmjs.org:${upstream.port}`));
    expect(statusLine(text)).toContain('200');
    await proxy.close();
    await once(socket, 'close');
    await expect(new Promise<void>((resolve, reject) => {
      const attempt = connectNet({ host: 'localhost', port: proxy.port });
      attempt.once('connect', () => { attempt.destroy(); reject(new Error('端口仍在监听')); });
      attempt.once('error', () => { resolve(); });
    })).resolves.toBeUndefined();
  });

  it('关闭可重复调用', async () => {
    const proxy = await startProxy();
    await Promise.all([proxy.close(), proxy.close()]);
    await proxy.close();
  });
});
