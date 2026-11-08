import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { validatedOpenAIFetch } from '../src/openai-sse-fetch.js';

describe('OpenAI SSE fetch 适配器', () => {
  let server: Server | undefined;
  let baseURL = '';

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<URL> {
    server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本地 HTTP 夹具未绑定端口。');
    baseURL = `http://127.0.0.1:${address.port}`;
    return new URL(baseURL);
  }

  it('通过 RequestInfo 接收普通响应并保持响应内容', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });

    const response = await validatedOpenAIFetch(url.toString());

    expect(await response.json()).toEqual({ ok: true });
  });

  it('接受 URL 与 RequestInit，并透传非 SSE 状态及内容', async () => {
    const url = await listen((request, response) => {
      expect(request.method).toBe('POST');
      response.writeHead(422, { 'Content-Type': 'application/json' });
      response.end('{"error":"invalid"}');
    });

    const response = await validatedOpenAIFetch(url, { method: 'POST', body: 'request' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'invalid' });
  });

  it('跨任意网络分片解析事件，并在 EOF 交付最后一个完整事件', async () => {
    const frame = 'data: {"choices":[{"delta":{"content":"分片文本"},"finish_reason":"stop"}]}';
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const part of [`da`, `ta: {"choices":[{"delta":{"content":`, `"分片文本"},"finish_reason":"stop"}]}`]) {
        response.write(part);
      }
      response.end();
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);

    expect(await response.text()).toBe(frame);
  });

  it('非工具事件在服务端结束流前及时透传', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"及时"}}]}\n\n');
      setTimeout(() => response.end(), 500);
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);
    const reader = response.body!.getReader();
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('非工具事件未及时透传。')), 200)),
    ]);

    expect(new TextDecoder().decode(firstChunk.value)).toContain('及时');
    await reader.cancel();
  });

  it('验证完整工具批次后按原顺序交付所有帧', async () => {
    const first = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_file","arguments":"{}"}}]}}]}\n\n';
    const second = 'data: {"choices":[{"delta":{"content":"中间事件"}}]}\n\n';
    const finish = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}';
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(first);
      response.write(second);
      response.end(finish);
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);

    expect(await response.text()).toBe(first + second + finish);
  });

  it.each([
    ['缺失 ID', '{"index":0,"function":{"name":"write_file","arguments":"{}"}}'],
    ['空白 ID', '{"index":0,"id":"  ","function":{"name":"write_file","arguments":"{}"}}'],
  ])('工具调用 %s 时以 PROVIDER_ERROR 终止流', async (_case, call) => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: {"choices":[{"delta":{"tool_calls":[${call}]}}]}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`);
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);

    await expect(response.text()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it.each([
    ['不同索引重复 ID', [
      { index: 0, id: 'duplicate', function: { name: 'write_file', arguments: '{}' } },
      { index: 1, id: 'duplicate', function: { name: 'write_file', arguments: '{}' } },
    ]],
    ['索引 ID 改变', [
      { index: 0, id: 'original', function: { name: 'write_file', arguments: '{}' } },
      { index: 0, id: 'changed', function: { arguments: '' } },
    ]],
    ['完整参数后重复起始帧', [
      { index: 0, id: 'original', function: { name: 'write_file', arguments: '{}' } },
      { index: 0, id: 'original', function: { name: 'write_file', arguments: '{}' } },
    ]],
  ])('工具批次出现%s时以 PROVIDER_ERROR 终止流', async (_case, calls) => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`);
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);

    await expect(response.text()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('消费方取消响应流时取消底层 HTTP 响应体', async () => {
    let disconnected!: () => void;
    const connectionClosed = new Promise<void>((resolve) => { disconnected = resolve; });
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n');
      response.on('close', disconnected);
    });

    const response = await validatedOpenAIFetch(`${baseURL}/stream`);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('consumer stopped');

    await expect(connectionClosed).resolves.toBeUndefined();
  });
});
