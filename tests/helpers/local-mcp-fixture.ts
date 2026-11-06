import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface FixtureMCPTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; [keyword: string]: unknown };
}

export const echoTool: FixtureMCPTool = {
  name: 'echo', description: '返回收到的文字',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
};

// 真实 HTTP/JSON-RPC 夹具；GET 流可选，POST 支持 JSON 与 SSE 响应。
export async function startLocalMCP(options: { sse?: boolean; hang?: 'initialize' | 'tools/list' | 'tools/call' } = {}) {
  let tools: FixtureMCPTool[] = [echoTool];
  const requests: Array<{ method: string; params?: Record<string, unknown>; headers: IncomingHttpHeaders }> = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: Record<string, unknown> };
      requests.push({ method: message.method, ...(message.params ? { params: message.params } : {}), headers: req.headers });
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      if (message.method === options.hang) return;
      let result: unknown;
      if (message.method === 'server/discover') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1.0' } };
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'tools/call') {
        const call = message.params as { name: string; arguments: Record<string, unknown> };
        calls.push(call);
        result = call.arguments.text === 'fail'
          ? { isError: true, content: [{ type: 'text', text: '远端声明失败' }] }
          : { content: [{ type: 'text', text: `远端收到：${String(call.arguments.text ?? call.arguments.value)}` }] };
      } else throw new Error('Unsupported fixture request');
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      res.writeHead(200, { 'Content-Type': options.sse ? 'text/event-stream' : 'application/json' });
      res.end(options.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP 夹具未绑定端口');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, calls, requests,
    setTools: (next: FixtureMCPTool[]) => { tools = next; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startLocalMCP({ sse: process.argv.includes('--sse') });
  process.stdout.write(`本地 MCP 夹具：${fixture.url}\n工具：echo({text: string})；text 为 fail 时返回普通工具错误。\n`);
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
