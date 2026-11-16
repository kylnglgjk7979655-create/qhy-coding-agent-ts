import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ToolRegistry } from '../tool-registry.js';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_CONTENT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'metadata.google.com',
  'instance-data', 'instance-data.ec2.internal',
]);

/** 本机、内网、链路本地、云 metadata 与保留地址都不能作为 WebFetch 目标。 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a, b, c] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a! >= 224;
}

function parseIpv6Words(address: string): number[] | undefined {
  let normalized = address.split('%')[0]!;
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(separator + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    normalized = `${normalized.slice(0, separator + 1)}${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const [left = '', right = ''] = normalized.split('::');
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 0 || (normalized.includes('::') && missing === 0)) return undefined;
  const parts = [...leftParts, ...Array<string>(normalized.includes('::') ? missing : 0).fill('0'), ...rightParts];
  if (parts.length !== 8) return undefined;
  const words = parts.map((part) => (/^[0-9a-f]{1,4}$/iu.test(part) ? Number.parseInt(part, 16) : -1));
  return words.some((word) => word < 0) ? undefined : words;
}

function embeddedIpv4(words: number[], offset: number): string {
  const high = words[offset]!;
  const low = words[offset + 1]!;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateIpv6(address: string): boolean {
  const words = parseIpv6Words(address);
  if (!words) return true;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0]! & 0xfe00) === 0xfc00) return true;
  if ((words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xffc0) === 0xfec0) return true;
  if ((words[0]! & 0xff00) === 0xff00) return true;
  // IPv4 映射、IPv4 兼容、NAT64 与 6to4 都把 IPv4 地址嵌入在 IPv6 中，按实际 IPv4 判断。
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(words, 6));
  }
  if (words.slice(0, 6).every((word) => word === 0)) return isPrivateIpv4(embeddedIpv4(words, 6));
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return isPrivateIpv4(embeddedIpv4(words, 6));
  }
  if (words[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(words, 1));
  if (words[0] === 0x2001 && words[1] === 0xdb8) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) return isPrivateIpv6(address);
  return true;
}

async function resolvePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error('WebFetch 地址无效，请提供完整的 HTTP(S) URL。'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebFetch 只允许访问公开的 HTTP/HTTPS 地址。');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('WebFetch 地址不能包含用户名或密码。');
  }
  // URL 对 IPv6 主机保留方括号；去掉后才能用 isIP 判断。
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (hostname === '' || BLOCKED_HOSTNAMES.has(hostname)
    || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('WebFetch 拒绝访问本机、内网或云服务 metadata 地址。');
  }
  let addresses: string[];
  if (isIP(hostname) !== 0) addresses = [hostname];
  else {
    try { addresses = (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address); }
    catch { throw new Error(`WebFetch 无法解析主机 ${hostname}。`); }
  }
  if (addresses.length === 0) throw new Error(`WebFetch 无法解析主机 ${hostname}。`);
  if (addresses.some(isPrivateAddress)) {
    throw new Error('WebFetch 拒绝访问本机、内网或云服务 metadata 地址。');
  }
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function isTextContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json'
    || type === 'application/xml' || type === 'application/xhtml+xml'
    || type === 'application/javascript';
}

async function readLimitedBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = MAX_BODY_BYTES - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total = MAX_BODY_BYTES;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function fetchFollowingPublicRedirects(initial: URL, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  let url = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'qhy-coding-agent/0.1 WebFetch', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });
    if (response.status < 300 || response.status > 399) return { response, url };
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error('WebFetch 收到重定向响应但没有 Location。');
    url = await resolvePublicUrl(new URL(location, url).href);
  }
  throw new Error('WebFetch 重定向次数过多。');
}

export function registerWebFetchTool(registry: ToolRegistry): void {
  registry.register({
    name: 'WebFetch',
    concurrency: 'parallel',
    description: '获取公开 HTTP/HTTPS 网页内容。url 为目标地址，prompt 说明希望从内容中获取的信息。拒绝本机、内网、链路本地和云 metadata 地址。',
    inputSchema: z.strictObject({
      url: z.string().min(1),
      prompt: z.string().min(1),
    }),
    prepare: async ({ url, prompt }) => {
      let target: URL | undefined;
      try { target = new URL(url); } catch { /* 地址无效在 execute 阶段返回明确错误。 */ }
      return {
        input: { url, prompt },
        details: {
          ...(target === undefined ? {} : { target: target.origin, urlHost: target.hostname }),
          requestedUrl: url,
        },
      };
    },
    execute: async ({ url }, execution) => {
      const initial = await resolvePublicUrl(url);
      const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const signal = execution.abortSignal === undefined
        ? timeout : AbortSignal.any([execution.abortSignal, timeout]);
      let fetched: { response: Response; url: URL };
      try { fetched = await fetchFollowingPublicRedirects(initial, signal); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('WebFetch')) throw error;
        if (timeout.aborted) throw new Error('WebFetch 请求超时。');
        throw new Error('WebFetch 无法访问目标地址。');
      }
      const { response, url: finalUrl } = fetched;
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`WebFetch 请求失败（HTTP ${response.status}）。`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!isTextContentType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`WebFetch 不支持该响应内容类型：${contentType || '未知'}。`);
      }
      let body: { text: string; truncated: boolean };
      try { body = await readLimitedBody(response); }
      catch (error) {
        if (timeout.aborted) throw new Error('WebFetch 请求超时。');
        if (execution.abortSignal?.aborted) throw error;
        throw new Error('WebFetch 读取响应失败。');
      }
      const isHtml = /html/iu.test(contentType);
      const text = isHtml ? htmlToText(body.text) : body.text;
      const truncatedByLength = text.length > MAX_CONTENT_CHARS;
      return {
        url,
        finalUrl: finalUrl.href,
        status: response.status,
        content: truncatedByLength ? text.slice(0, MAX_CONTENT_CHARS) : text,
        truncated: body.truncated || truncatedByLength,
      };
    },
  });
}
