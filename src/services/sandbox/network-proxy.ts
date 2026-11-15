import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { connect as connectSocket, isIP } from 'node:net';
import type { Duplex } from 'node:stream';

/** 代理拒绝目标的原因；顺序即校验顺序。 */
export type ProxyViolationReason =
  | 'invalid-target'
  | 'port-not-allowed'
  | 'host-not-allowed'
  | 'dns-failed'
  | 'dangerous-address';

/** 一次被代理拒绝的目标；调用结束前汇总给命令输出。 */
export interface ProxyViolation {
  host: string;
  port: number;
  reason: ProxyViolationReason;
  /** 毫秒时间戳，由注入的时钟产生。 */
  timestamp: number;
}

export type ResolveHost = (host: string) => Promise<readonly string[]>;

/** 出站连接只接收已校验的解析地址，避免连接时二次解析被 DNS rebinding 绕过。 */
export type OpenTunnel = (target: { address: string; port: number }) => Promise<Duplex>;

export interface NetworkProxyOptions {
  /** 精确域名或 `*.` 子域白名单；空列表拒绝全部目标。 */
  allowedHosts: readonly string[];
  /** 允许连接的 TCP 端口。 */
  allowedPorts: readonly number[];
  resolveHost?: ResolveHost;
  openTunnel?: OpenTunnel;
  now?: () => number;
}

export interface NetworkProxy {
  /** 本机随机监听端口；沙箱子进程只被允许连这个端口。 */
  readonly port: number;
  readonly violations: readonly ProxyViolation[];
  /** 关闭监听并终止所有活动隧道；可重复调用。 */
  close: () => Promise<void>;
}

/**
 * 启动一次沙箱调用专属的 CONNECT 代理。
 * 代理只建立原始 TCP 隧道，不终结 TLS、不安装 CA，也不检查隧道内容。
 */
export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxy> {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const openTunnel = options.openTunnel ?? defaultOpenTunnel;
  const now = options.now ?? Date.now;
  const violations: ProxyViolation[] = [];
  const clientSockets = new Set<Duplex>();
  const upstreamSockets = new Set<Duplex>();

  const server: Server = createServer((_request, response) => {
    // CONNECT 以外的代理请求没有合法语义；不读取正文，直接拒绝。
    response.writeHead(405, { Allow: 'CONNECT', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Only CONNECT is supported.\n');
  });

  server.on('connection', (socket) => {
    clientSockets.add(socket);
    socket.on('close', () => { clientSockets.delete(socket); });
  });

  server.on('connect', (request: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    void handleConnect(request, clientSocket, head).catch(() => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
  });

  async function handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    // 解析与连接都是异步的；期间客户端断开不能让 socket 的 error 事件变成未处理异常。
    clientSocket.on('error', () => {});
    const rawTarget = request.url ?? '';
    const target = parseConnectTarget(rawTarget);
    if (target === undefined) {
      reject(clientSocket, { host: rawTarget, port: 0, reason: 'invalid-target', timestamp: now() });
      return;
    }
    const { host, port } = target;
    // 顺序固定：端口、域名、DNS。先拒绝已经确定违规的目标，避免无谓解析与连接。
    if (!options.allowedPorts.includes(port)) {
      reject(clientSocket, { host, port, reason: 'port-not-allowed', timestamp: now() });
      return;
    }
    if (!isHostAllowed(host, options.allowedHosts)) {
      reject(clientSocket, { host, port, reason: 'host-not-allowed', timestamp: now() });
      return;
    }
    let addresses: readonly string[];
    try {
      addresses = await resolveHost(host);
    } catch {
      reject(clientSocket, { host, port, reason: 'dns-failed', timestamp: now() });
      return;
    }
    if (addresses.length === 0) {
      reject(clientSocket, { host, port, reason: 'dns-failed', timestamp: now() });
      return;
    }
    // 任一解析结果危险即拒绝：允许的域名被 DNS rebinding 指向内网时不能放行。
    if (addresses.some(isDangerousAddress)) {
      reject(clientSocket, { host, port, reason: 'dangerous-address', timestamp: now() });
      return;
    }
    if (clientSocket.destroyed) return;

    let upstream: Duplex | undefined;
    // 同一域名的多个解析结果都已确认安全；按顺序尝试，避免首选地址不可达时误判为网关故障。
    for (const address of addresses) {
      try {
        upstream = await openTunnel({ address, port });
        break;
      } catch {
        // 继续尝试下一个地址；全部失败再返回 502。
      }
      if (clientSocket.destroyed) return;
    }
    if (upstream === undefined) {
      // 上游不可达不是策略拒绝；返回网关错误，不产生违规记录。
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    if (clientSocket.destroyed) {
      upstream.destroy();
      return;
    }
    upstreamSockets.add(upstream);
    upstream.on('close', () => { upstreamSockets.delete(upstream); });

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    // 任一端断开都要终止另一端，避免隧道半开残留。
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  }

  function reject(clientSocket: Duplex, violation: ProxyViolation): void {
    violations.push(violation);
    const body = `${violation.reason}\n`;
    clientSocket.end(
      'HTTP/1.1 403 Forbidden\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + 'Connection: close\r\n\r\n'
      + body,
    );
  }

  await new Promise<void>((resolve, rejectListen) => {
    // 只监听本机回环地址的随机端口；不对外暴露。
    server.once('error', rejectListen);
    server.listen(0, 'localhost', () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('代理未能绑定本机端口。');
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // 先停止接受新连接，再终止已有客户端与上游隧道；server.close 会在连接清空后完成。
      const closed = closeServer(server);
      for (const socket of clientSockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      clientSockets.clear();
      upstreamSockets.clear();
      await closed;
    })();
    return closePromise;
  };

  return { port: address.port, get violations() { return [...violations]; }, close };
}

/** 解析 CONNECT 的 authority-form 目标；拒绝凭据、路径和缺失端口。 */
function parseConnectTarget(raw: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  if (url.port === '') return undefined;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  // URL.hostname 对 IPv6 保留方括号，连接前去掉。
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1');
  if (host === '') return undefined;
  return { host, port };
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/u, '');
}

/** 精确匹配或 `*.` 子域匹配；`*.example.com` 不匹配裸 `example.com`。 */
function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const candidate = normalizeHost(host);
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2);
      return suffix !== '' && candidate.endsWith(`.${suffix}`);
    }
    return candidate === allowed;
  });
}

const defaultResolveHost: ResolveHost = async (host) => {
  // 字面量地址不做 DNS，避免解析器把 IP 改写或返回额外结果。
  if (isIP(host) !== 0) return [host];
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
};

const defaultOpenTunnel: OpenTunnel = async ({ address, port }) => {
  const socket = connectSocket({ host: address, port });
  await new Promise<void>((resolve, rejectConnect) => {
    socket.once('connect', () => { resolve(); });
    socket.once('error', (error) => { rejectConnect(error); });
  });
  return socket;
};

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * 回环、私网、链路本地和云 metadata 地址一律视为危险目标。
 * 无法识别的地址按危险处理，保持拒绝优先。
 */
function isDangerousAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isDangerousIpv4(address);
  if (version === 6) return isDangerousIpv6(address);
  return true;
}

function isDangerousIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === undefined || b === undefined) return true;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isDangerousIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true;
  // 未指定地址和回环地址。
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌 IPv4 判定。
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isDangerousIpv4(bytes.slice(12).join('.'));
  }
  // fc00::/7 唯一本地地址与 fe80::/10 链路本地地址。
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  return false;
}

/** 把 IPv6 文本展开为 16 字节，供网段判断；含内嵌 IPv4 时一并转换。 */
function ipv6Bytes(address: string): number[] | undefined {
  let input = address.toLowerCase();
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon === -1) return undefined;
    const ipv4 = input.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const [a, b, c, d] = ipv4.split('.').map(Number) as [number, number, number, number];
    input = `${input.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (half: string): number[] | undefined => {
    if (half === '') return [];
    const groups: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? '');
  const right = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (left === undefined || right === undefined) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    // `::` 至少代表一个全零分组。
    if (left.length + right.length >= 8) return undefined;
    groups = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  } else {
    if (left.length !== 8) return undefined;
    groups = left;
  }
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}