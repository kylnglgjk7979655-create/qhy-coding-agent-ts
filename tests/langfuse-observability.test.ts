import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { prepareConversation } from '../src/services/compact/context-summary.js';
import { LangfuseTracer, createLangfuseTracer } from '../src/services/observability/langfuse.js';
import { configSchema, DEFAULT_SANDBOX, loadConfig, loggableConfig } from '../src/services/settings/config.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import { tempDir } from './helpers/temp-dir.js';

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function recordingFetch(options: { fail?: boolean } = {}): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    if (options.fail) throw new Error('langfuse unavailable');
    return new Response(JSON.stringify({ successes: [], errors: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function eventsOf(requests: RecordedRequest[]): IngestionEvent[] {
  return requests.flatMap(({ init }) => {
    const payload = JSON.parse(String(init.body)) as { batch: IngestionEvent[] };
    return payload.batch;
  });
}

function newTracer(fetchImpl: typeof fetch, sessionId = 'conversation-fixture'): LangfuseTracer {
  return new LangfuseTracer({
    baseURL: 'https://langfuse.example',
    publicKey: 'pk-test-observability',
    secretKey: 'sk-test-observability',
    sessionId,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
}

const traces: LangfuseTracer[] = [];
const extraRoots: string[] = [];
const serverClosers: Array<() => Promise<void>> = [];
let workspace: string | undefined;
let closeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeFixture?.();
  closeFixture = undefined;
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
  await Promise.all(serverClosers.splice(0).map((close) => close()));
  await Promise.all(extraRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  traces.length = 0;
});

async function startFakeLangfuse(status = 200): Promise<{
  baseURL: string;
  requests: Array<{ headers: Record<string, string | string[] | undefined>; batch: IngestionEvent[] }>;
}> {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; batch: IngestionEvent[] }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { batch: IngestionEvent[] };
      requests.push({ headers: request.headers, batch: payload.batch });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{}');
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Langfuse 夹具未绑定端口。');
  serverClosers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseURL: `http://127.0.0.1:${address.port}`, requests };
}

describe('Langfuse 跟踪协议', () => {
  it('按 Langfuse ingestion 格式上报关联的轮次、模型请求、工具与审批，且不把凭据写入事件', async () => {
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    const trace = tracer.startTrace({ name: 'agent.round', input: '运行命令', metadata: { model: 'fixture' } });
    const generation = tracer.startGeneration({
      traceId: trace.id,
      name: 'model.request',
      model: 'fixture',
      input: [{ role: 'user', content: '运行命令' }],
    });
    generation.end({ output: '答复', status: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 } });
    const tool = tracer.startSpan({ traceId: trace.id, name: 'tool.Bash', input: { command: 'echo hi' } });
    tool.end({ output: { is_error: false, output: 'hi' }, status: 'succeeded' });
    const approval = tracer.startSpan({ traceId: trace.id, parentObservationId: tool.id, name: 'approval.Bash', input: { command: 'echo hi' } });
    approval.end({ output: 'approve', status: 'succeeded' });
    trace.end({ output: '答复', status: 'succeeded' });
    await tracer.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://langfuse.example/api/public/ingestion');
    expect(requests[0]!.init.method).toBe('POST');
    const authorization = (requests[0]!.init.headers as Record<string, string>).Authorization;
    expect(authorization).toBe(`Basic ${Buffer.from('pk-test-observability:sk-test-observability').toString('base64')}`);

    const events = eventsOf(requests);
    expect(events.map(({ type }) => type)).toEqual(['trace-create', 'generation-create', 'span-create', 'span-create']);
    const traceEvent = events[0]!;
    expect(traceEvent.body).toMatchObject({
      id: trace.id, name: 'agent.round', sessionId: 'conversation-fixture', input: '运行命令', output: '答复', metadata: { model: 'fixture' },
    });
    const generationEvent = events[1]!;
    expect(generationEvent.body).toMatchObject({
      id: generation.id, traceId: trace.id, name: 'model.request', model: 'fixture',
      usageDetails: { input: 10, output: 5 }, level: 'DEFAULT',
    });
    expect(generationEvent.body).not.toHaveProperty('costDetails');
    expect(events[2]!.body).toMatchObject({ name: 'tool.Bash', traceId: trace.id, input: { command: 'echo hi' }, level: 'DEFAULT' });
    expect(events[3]!.body).toMatchObject({ name: 'approval.Bash', traceId: trace.id, parentObservationId: tool.id, output: 'approve' });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('pk-test-observability');
    expect(serialized).not.toContain('sk-test-observability');
  });

  it('记录失败状态但不虚构费用，只有明确提供的费用才进入 costDetails', async () => {
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    const trace = tracer.startTrace({ name: 'agent.round' });
    const failed = tracer.startGeneration({ traceId: trace.id, name: 'model.request', model: 'fixture' });
    failed.end({ status: 'failed', error: { code: 'PROVIDER_ERROR', message: '模型响应流无效' }, usage: { inputTokens: 3 } });
    const fallback = tracer.startGeneration({ traceId: trace.id, name: 'model.request', model: 'fixture' });
    fallback.end({ status: 'succeeded', usage: { inputTokens: 4, outputTokens: 2, totalCostUsd: 0.0012 } });
    trace.end({ status: 'failed', error: { code: 'PROVIDER_ERROR', message: '模型响应流无效' } });
    await tracer.flush();

    const generations = eventsOf(requests).filter(({ type }) => type === 'generation-create');
    expect(generations[0]!.body).toMatchObject({ level: 'ERROR', statusMessage: '模型响应流无效', usageDetails: { input: 3 } });
    expect(generations[0]!.body).not.toHaveProperty('costDetails');
    expect(generations[1]!.body).toMatchObject({ level: 'DEFAULT', usageDetails: { input: 4, output: 2 }, costDetails: { total: 0.0012 } });
  });

  it('Langfuse 不可达时 flush 不抛错，也不影响已结束的观察', async () => {
    const { fetchImpl, requests } = recordingFetch({ fail: true });
    const tracer = newTracer(fetchImpl);
    const trace = tracer.startTrace({ name: 'agent.round' });
    expect(() => {
      tracer.startGeneration({ traceId: trace.id, name: 'model.request', model: 'fixture' })
        .end({ output: '答复', status: 'succeeded' });
      trace.end({ output: '答复', status: 'succeeded' });
    }).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('默认关闭时不创建跟踪器，显式启用时从环境变量读取凭据', async () => {
    const disabled = configSchema.parse({});
    expect(disabled.observability.langfuse).toEqual({
      enabled: false,
      baseURL: 'https://cloud.langfuse.com',
      publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'LANGFUSE_SECRET_KEY',
    });
    const { fetchImpl, requests } = recordingFetch();
    expect(createLangfuseTracer({ config: disabled, env: {}, sessionId: 'conversation', fetchImpl })).toBeUndefined();
    expect(requests).toHaveLength(0);

    const enabled = configSchema.parse({ observability: { langfuse: { enabled: true } } });
    const tracer = createLangfuseTracer({
      config: enabled,
      env: { LANGFUSE_PUBLIC_KEY: 'pk-env', LANGFUSE_SECRET_KEY: 'sk-env' },
      sessionId: 'conversation',
      fetchImpl,
    });
    expect(tracer).toBeInstanceOf(LangfuseTracer);
    const trace = tracer!.startTrace({ name: 'agent.round' });
    trace.end({ status: 'succeeded' });
    await tracer!.flush();
    expect(requests).toHaveLength(1);
    expect(eventsOf(requests)[0]!.body).toMatchObject({ sessionId: 'conversation' });
  });
});

describe('Langfuse 配置', () => {
  it('启用时缺少凭据在启动阶段报配置错误，未启用时不要求凭据', async () => {
    workspace = await tempDir('qhy-langfuse-config-');
    await mkdir(join(workspace, '.agent'), { recursive: true });
    await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
      observability: { langfuse: { enabled: true } },
    }));
    await expect(loadConfig({
      cwd: workspace, workspace: '.', env: { OPENAI_API_KEY: 'model-key' }, home: workspace,
    })).rejects.toMatchObject({ code: 'CONFIG_ERROR', message: expect.stringContaining('LANGFUSE_PUBLIC_KEY') });

    await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
      observability: { langfuse: { enabled: false } },
    }));
    const config = await loadConfig({
      cwd: workspace, workspace: '.', env: { OPENAI_API_KEY: 'model-key' }, home: workspace,
    });
    expect(config.observability?.langfuse.enabled).toBe(false);
    expect(JSON.stringify(loggableConfig(config))).not.toContain('model-key');
  });

  it('启用后从环境变量读取凭据且日志配置不包含凭据值', async () => {
    workspace = await tempDir('qhy-langfuse-config-');
    await mkdir(join(workspace, '.agent'), { recursive: true });
    await writeFile(join(workspace, '.agent', 'settings.json'), JSON.stringify({
      observability: { langfuse: { enabled: true, baseURL: 'https://langfuse.internal' } },
    }));
    const config = await loadConfig({
      cwd: workspace,
      workspace: '.',
      env: {
        OPENAI_API_KEY: 'model-key',
        LANGFUSE_PUBLIC_KEY: 'pk-from-env',
        LANGFUSE_SECRET_KEY: 'sk-from-env',
      },
      home: workspace,
    });
    expect(config.observability?.langfuse).toMatchObject({ enabled: true, baseURL: 'https://langfuse.internal' });
    const logged = JSON.stringify(loggableConfig(config));
    expect(logged).not.toContain('pk-from-env');
    expect(logged).not.toContain('sk-from-env');
  });
});

describe('Agent 运行路径的 Langfuse 跟踪', () => {
  async function fixtureConfig(baseURL: string, overrides: Partial<ResolvedConfig> = {}): Promise<ResolvedConfig> {
    return {
      approval: { mode: 'auto', timeoutMs: 30_000 },
      permissions: { allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL, workspace: (await realpath(workspace!)), timeoutMs: 5000, maxSteps: 6,
      ...overrides,
    };
  }

  it('主 Agent 的工具调用、模型审批和模型请求都关联到同一轮次并记录用量与耗时', async () => {
    workspace = await tempDir('qhy-langfuse-agent-');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'bash-call', type: 'function', function: {
        name: 'Bash', arguments: JSON.stringify({ command: 'printf langfuse-ok' }),
      } }] };
      return { content: '命令已执行。' };
    });
    closeFixture = fixture.close;
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    traces.push(tracer);
    const trace = tracer.startTrace({ name: 'agent.round', input: '运行命令' });
    const config = await fixtureConfig(fixture.baseURL);

    await runAgent(config, '运行命令', { smokeTool: false, tracing: { tracer, traceId: trace.id } });
    trace.end({ output: '命令已执行。', status: 'succeeded' });
    await tracer.flush();

    const events = eventsOf(requests);
    expect(events.map(({ type }) => type)).toContain('trace-create');
    expect(events.find(({ type }) => type === 'trace-create')!.body).toMatchObject({
      id: trace.id, sessionId: 'conversation-fixture', name: 'agent.round',
    });
    const generations = events.filter(({ type }) => type === 'generation-create');
    expect(generations.map(({ body }) => body.name)).toEqual(expect.arrayContaining(['model.request', 'approval.model']));
    for (const generation of generations) {
      expect(generation.body).toMatchObject({ model: 'fixture', usageDetails: { input: 10, output: 5 } });
      expect(generation.body).toHaveProperty('startTime');
      expect(generation.body).toHaveProperty('endTime');
      expect(generation.body).not.toHaveProperty('costDetails');
    }
    const toolSpan = events.find(({ type, body }) => type === 'span-create' && body.name === 'tool.Bash');
    expect(toolSpan?.body).toMatchObject({
      traceId: trace.id, input: { command: 'printf langfuse-ok' }, level: 'DEFAULT',
    });
    expect(toolSpan?.body.output).toMatchObject({ is_error: false, output: { stdout: 'langfuse-ok' } });
    const approvalSpan = events.find(({ type, body }) => type === 'span-create' && body.name === 'approval.Bash');
    expect(approvalSpan?.body).toMatchObject({ traceId: trace.id, output: 'approve' });
  });

  it('模型请求失败时 trace 与 generation 都标记为失败且保留错误状态', async () => {
    workspace = await tempDir('qhy-langfuse-failure-');
    const fixture = await startLocalOpenAIModel(() => ({ status: 401, content: 'unauthorized' }));
    closeFixture = fixture.close;
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    traces.push(tracer);
    const trace = tracer.startTrace({ name: 'agent.round', input: '失败请求' });
    const config = await fixtureConfig(fixture.baseURL);

    await expect(runAgent(config, '失败请求', {
      smokeTool: false,
      tracing: { tracer, traceId: trace.id },
    })).rejects.toMatchObject({ code: 'AUTH_ERROR' });
    trace.end({ status: 'failed', error: { code: 'AUTH_ERROR', message: '模型鉴权失败' } });
    await tracer.flush();

    const events = eventsOf(requests);
    expect(events.find(({ type }) => type === 'trace-create')!.body).toMatchObject({
      metadata: { status: 'failed', errorCode: 'AUTH_ERROR' },
    });
    const generation = events.find(({ type, body }) => type === 'generation-create' && body.name === 'model.request');
    expect(generation?.body).toMatchObject({ level: 'ERROR', metadata: { status: 'failed' } });
    expect(generation?.body).toHaveProperty('statusMessage');
  });

  it('子 Agent 产生独立 span，其模型请求继续关联同一 trace 与父 span', async () => {
    workspace = await tempDir('qhy-langfuse-subagent-');
    const fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate-explore', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '调查', prompt: '检查工作区', subagent_type: 'explore' }),
      } }] };
      if (index === 2) return { content: '调查完成。' };
      return { content: '子 Agent 已报告。' };
    });
    closeFixture = fixture.close;
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    traces.push(tracer);
    const trace = tracer.startTrace({ name: 'agent.round', input: '委派调查' });
    const config = await fixtureConfig(fixture.baseURL);

    await runAgent(config, '委派调查', { smokeTool: false, tracing: { tracer, traceId: trace.id } });
    trace.end({ output: '子 Agent 已报告。', status: 'succeeded' });
    await tracer.flush();

    const events = eventsOf(requests);
    const subagentSpan = events.find(({ type, body }) => type === 'span-create' && body.name === 'subagent.explore');
    expect(subagentSpan?.body).toMatchObject({ traceId: trace.id, input: { description: '调查', prompt: '检查工作区' }, output: '调查完成。' });
    const childGenerations = events.filter(({ type, body }) =>
      type === 'generation-create' && body.parentObservationId === subagentSpan!.body.id);
    expect(childGenerations.length).toBeGreaterThan(0);
    expect(childGenerations.every(({ body }) => body.model === 'fixture')).toBe(true);
    expect(events.some(({ type, body }) => type === 'span-create' && body.name === 'tool.agent')).toBe(true);
  });

  it('自动压缩的摘要请求产生摘要 span 与模型生成记录', async () => {
    workspace = await tempDir('qhy-langfuse-summary-');
    const fixture = await startLocalOpenAIModel(
      (_request) => ({ content: '不用于摘要' }),
      undefined,
      () => ({ content: '摘要：此前工作已完成。' }),
    );
    closeFixture = fixture.close;
    const { fetchImpl, requests } = recordingFetch();
    const tracer = newTracer(fetchImpl);
    traces.push(tracer);
    const trace = tracer.startTrace({ name: 'agent.round', input: '长历史' });
    const config = await fixtureConfig(fixture.baseURL, {
      context: { capacityTokens: 20_000, answerReserveTokens: 100, maxOutputTokens: 1000 },
    });
    const history = [{ role: 'user' as const, content: 'history '.repeat(5_000) }];

    const compacted = await prepareConversation(
      config,
      'system',
      history,
      {},
      new AbortController().signal,
      undefined,
      undefined,
      { tracing: { tracer, traceId: trace.id } },
    );
    expect(JSON.stringify(compacted)).toContain('摘要：此前工作已完成。');
    trace.end({ status: 'succeeded' });
    await tracer.flush();

    const events = eventsOf(requests);
    const summarySpan = events.find(({ type, body }) => type === 'span-create' && body.name === 'conversation.summary');
    expect(summarySpan?.body).toMatchObject({ traceId: trace.id, output: '摘要：此前工作已完成。' });
    const summaryGeneration = events.find(({ type, body }) =>
      type === 'generation-create' && body.name === 'summary.model');
    expect(summaryGeneration?.body).toMatchObject({
      traceId: trace.id, parentObservationId: summarySpan!.body.id, model: 'fixture', usageDetails: { input: 10, output: 5 },
    });
  });
});

describe('CLI Langfuse 接线', () => {
  it('启用后按真实会话 ID 上报，关闭时不向 Langfuse 发送数据', async () => {
    const cwd = await tempDir('qhy-langfuse-cli-');
    const userDir = await tempDir('qhy-langfuse-cli-user-');
    extraRoots.push(cwd, userDir);
    await mkdir(join(cwd, '.agent'), { recursive: true });
    const fixture = await startLocalOpenAIModel(() => ({ content: '已处理。' }));
    closeFixture = fixture.close;
    const enabledLangfuse = await startFakeLangfuse();
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: fixture.baseURL,
      observability: { langfuse: { enabled: true, baseURL: enabledLangfuse.baseURL } },
    }));
    const env = {
      TEST_MODEL_API_KEY: 'model-key',
      LANGFUSE_PUBLIC_KEY: 'pk-cli',
      LANGFUSE_SECRET_KEY: 'sk-cli',
    };

    const cli = startCLI({ cwd, userDir, input: '你好\n/exit\n', env });
    const cliResult = await cli.done;
    expect(cliResult.code, `${cliResult.stdout}\n---stderr---\n${cliResult.stderr}`).toBe(0);
    expect(enabledLangfuse.requests).toHaveLength(1);
    const [conversationId] = await readdir(join(userDir, '.qhy-coding-agents', 'sessions'));
    expect(conversationId).toBeTruthy();
    const batch = enabledLangfuse.requests[0]!.batch;
    expect(batch.find(({ type }) => type === 'trace-create')!.body).toMatchObject({
      sessionId: conversationId, name: 'agent.round', input: '你好', output: '已处理。', metadata: { status: 'succeeded' },
    });
    expect(batch.some(({ type, body }) => type === 'generation-create' && body.name === 'model.request')).toBe(true);
    expect(enabledLangfuse.requests[0]!.headers.authorization)
      .toBe(`Basic ${Buffer.from('pk-cli:sk-cli').toString('base64')}`);

    const disabledLangfuse = await startFakeLangfuse();
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: fixture.baseURL,
      observability: { langfuse: { enabled: false, baseURL: disabledLangfuse.baseURL } },
    }));
    const disabled = startCLI({ cwd, userDir, input: '继续\n/exit\n', env });
    expect((await disabled.done).code).toBe(0);
    expect(disabledLangfuse.requests).toHaveLength(0);
  });
});