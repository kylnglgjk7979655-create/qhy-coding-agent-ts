import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface FixtureToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface FixtureRequest {
  model?: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
}

export type FixtureResponse = { content: string }
  | { status: number; content: string }
  | { calls: FixtureToolCall[] }
  | { frames: Array<{ delta: Record<string, unknown>; finish_reason?: string | null; delayMs?: number }>; endDelayMs?: number };

export async function startLocalOpenAIModel(
  respond: (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>,
  review?: (request: FixtureRequest, index: number) => FixtureResponse | undefined | Promise<FixtureResponse | undefined>,
): Promise<{ baseURL: string; requests: FixtureRequest[]; approvalRequests: FixtureRequest[]; close: () => Promise<void> }> {
  const requests: FixtureRequest[] = [];
  const approvalRequests: FixtureRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const requestChunks: Buffer[] = [];
      for await (const chunk of req) requestChunks.push(Buffer.from(chunk as Uint8Array));
      const request = JSON.parse(Buffer.concat(requestChunks).toString()) as FixtureRequest;
      const isReview = request.messages.some(({ role, content }) => role === 'system' && content.includes('[工具调用审批]'));
      const recorded = isReview ? approvalRequests : requests;
      recorded.push(request);
      const reply: FixtureResponse | undefined = isReview
        ? (review ? await review(request, recorded.length) : { content: 'approve' })
        : await respond(request, recorded.length);
      if (reply === undefined) return;
      if ('status' in reply && typeof reply.status === 'number' && 'content' in reply) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: reply.content } }));
        return;
      }
      if (!request.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-review', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'calls' in reply ? 'tool_calls' : 'stop', message: { role: 'assistant', content: 'content' in reply ? reply.content : null, ...('calls' in reply ? { tool_calls: reply.calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      const chunks = 'frames' in reply
        ? reply.frames.map((frame) => ({ delayMs: frame.delayMs, payload: { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: frame.delta, finish_reason: frame.finish_reason ?? null }] } }))
        : [
          { delayMs: undefined, payload: { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: 'calls' in reply ? { tool_calls: reply.calls.map((call, index) => ({ index, ...call })) } : { content: reply.content }, finish_reason: null }] } },
          { delayMs: undefined, payload: { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'calls' in reply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } },
        ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let groupedEvents = '';
      for (const chunk of chunks) {
        if (chunk.delayMs) {
          if (groupedEvents) { res.write(groupedEvents); groupedEvents = ''; }
          await new Promise<void>((resolve) => setTimeout(resolve, chunk.delayMs));
        }
        groupedEvents += `data: ${JSON.stringify(chunk.payload)}\n\n`;
      }
      if (groupedEvents) res.write(groupedEvents);
      if ('frames' in reply && reply.endDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, reply.endDelayMs));
      res.end('data: [DONE]\n\n');
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
    approvalRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
