import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface FixtureToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface FixtureRequest {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ function: { name: string } }>;
}

export type FixtureResponse = { content: string } | { calls: FixtureToolCall[] };

export async function startLocalOpenAIModel(
  respond: (request: FixtureRequest, index: number) => FixtureResponse | undefined,
): Promise<{ baseURL: string; requests: FixtureRequest[]; close: () => Promise<void> }> {
  const requests: FixtureRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const request = JSON.parse(Buffer.concat(chunks).toString()) as FixtureRequest;
      requests.push(request);
      const reply = respond(request, requests.length);
      if (reply === undefined) return;
      const firstDelta = 'calls' in reply
        ? { tool_calls: reply.calls.map((call, index) => ({ index, ...call })) }
        : { content: reply.content };
      const first = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: firstDelta, finish_reason: null }] };
      const last = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'calls' in reply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地模型夹具未绑定端口。');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
