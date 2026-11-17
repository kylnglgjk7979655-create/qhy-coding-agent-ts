import { randomUUID } from 'node:crypto';
import { AgentError } from '../../utils/errors.js';

/** Langfuse ingestion 事件的本地类型；只覆盖本项目发送的 trace、span 与 generation。 */
interface IngestionEvent {
  id: string;
  type: 'trace-create' | 'span-create' | 'generation-create';
  timestamp: string;
  body: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 仅当调用方明确拿到供应商费用时填写；单位为 Langfuse 项目设定的费用单位。 */
  totalCost?: number;
}

export type ObservationStatus = 'succeeded' | 'failed' | 'cancelled' | 'rejected';

export interface ObservationResult {
  output?: unknown;
  status?: ObservationStatus;
  error?: { code?: string; message: string };
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ObservationStart {
  traceId: string;
  parentObservationId?: string;
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface GenerationStart extends ObservationStart {
  model: string;
  modelParameters?: Record<string, unknown>;
}

export interface TraceStart {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ObservationHandle {
  readonly id: string;
  readonly traceId: string;
  /** 结束观察并排队上报；重复调用只生效一次，内部故障不影响调用方。 */
  end(result?: ObservationResult): void;
}

export interface TraceHandle {
  readonly id: string;
  end(result?: ObservationResult): void;
}

export interface Tracer {
  startTrace(options: TraceStart): TraceHandle;
  startSpan(options: ObservationStart): ObservationHandle;
  startGeneration(options: GenerationStart): ObservationHandle;
  flush(): Promise<void>;
}

/** 一次 Agent 运行所在的 trace；子 Agent 用 parentObservationId 挂到所属 span。 */
export interface TracingScope {
  tracer: Tracer;
  traceId: string;
  parentObservationId?: string;
}

export interface LangfuseTracerOptions {
  baseURL: string;
  publicKey: string;
  secretKey: string;
  /** 关联同一对话；Langfuse 会话视图按该值聚合轮次。 */
  sessionId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

interface TraceState {
  event: IngestionEvent;
  sent: boolean;
  ended: boolean;
  /** 起始元数据在结束时与结果元数据合并，避免丢失调用方信息。 */
  metadata: Record<string, unknown>;
}

const levelByStatus: Record<ObservationStatus, 'DEFAULT' | 'WARNING' | 'ERROR'> = {
  succeeded: 'DEFAULT',
  failed: 'ERROR',
  cancelled: 'WARNING',
  rejected: 'WARNING',
};

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/**
 * Langfuse ingestion 只接受可序列化载荷；循环引用或无法序列化的值降级为字符串，
 * 不让跟踪数据构造影响 Agent 主流程。
 */
function serializable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function metadataOf(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...values.map((value) => serializable(value ?? {}) as Record<string, unknown>));
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Langfuse Cloud 的 HTTP ingestion 客户端。按轮次缓冲事件，在 flush 时一次提交；
 * 所有外部故障只被吞掉，不影响 Agent 主流程，也不把凭据写入事件正文。
 */
export class LangfuseTracer implements Tracer {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly events: IngestionEvent[] = [];
  private readonly traces = new Map<string, TraceState>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: LangfuseTracerOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  startTrace(options: TraceStart): TraceHandle {
    const id = randomUUID();
    const metadata = metadataOf(options.metadata);
    const event: IngestionEvent = {
      id: randomUUID(),
      type: 'trace-create',
      timestamp: nowIso(this.now),
      body: {
        id,
        name: options.name,
        sessionId: this.options.sessionId,
        timestamp: nowIso(this.now),
        ...(options.input === undefined ? {} : { input: serializable(options.input) }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(options.tags === undefined || options.tags.length === 0 ? {} : { tags: options.tags }),
      },
    };
    this.events.push(event);
    const state: TraceState = {
      event,
      sent: false,
      ended: false,
      metadata: (serializable(options.metadata ?? {}) as Record<string, unknown>),
    };
    this.traces.set(id, state);
    return {
      id,
      end: (result = {}) => {
        try {
          if (state.ended) return;
          state.ended = true;
          const status = result.status ?? 'succeeded';
          state.event.body.output = serializable(result.output);
          state.event.body.metadata = metadataOf(state.metadata, result.metadata, { status, ...(result.error === undefined ? {} : { errorCode: result.error.code }) });
          if (state.event.body.output === undefined) delete state.event.body.output;
          // 若起始事件已随此前批次发出，补发一次同 ID 的 trace-create 以更新最终结果。
          if (state.sent) {
            this.events.push({ ...state.event, id: randomUUID(), timestamp: nowIso(this.now) });
          }
        } catch {
          // 跟踪故障不影响主流程。
        }
      },
    };
  }

  startSpan(options: ObservationStart): ObservationHandle {
    return this.startObservation('span', options);
  }

  startGeneration(options: GenerationStart): ObservationHandle {
    return this.startObservation('generation', options);
  }

  flush(): Promise<void> {
    // 串行化批次；无论此前或本次上报出现何种故障，flush 本身都不应拒绝。
    this.chain = this.chain.catch(() => undefined).then(() => this.sendPending()).catch(() => undefined);
    return this.chain;
  }

  private startObservation(type: 'span' | 'generation', options: ObservationStart & { model?: string; modelParameters?: Record<string, unknown> }): ObservationHandle {
    const id = randomUUID();
    const startedAt = this.now();
    const startMetadata = serializable(options.metadata ?? {}) as Record<string, unknown>;
    let ended = false;
    return {
      id,
      traceId: options.traceId,
      end: (result = {}) => {
        try {
          if (ended) return;
          ended = true;
          const status = result.status ?? 'succeeded';
          const metadata = metadataOf(startMetadata, result.metadata, { status });
          const body: Record<string, unknown> = {
            id,
            traceId: options.traceId,
            name: options.name,
            startTime: new Date(startedAt).toISOString(),
            endTime: nowIso(this.now),
            level: levelByStatus[status],
            ...(result.error === undefined ? {} : { statusMessage: result.error.message }),
            ...(options.parentObservationId === undefined ? {} : { parentObservationId: options.parentObservationId }),
            ...(options.input === undefined ? {} : { input: serializable(options.input) }),
            ...(result.output === undefined ? {} : { output: serializable(result.output) }),
            ...(metadata === undefined ? {} : { metadata }),
          };
          if (type === 'generation') {
            body.model = options.model;
            if (options.modelParameters !== undefined) body.modelParameters = serializable(options.modelParameters);
            const usageDetails: Record<string, number> = {};
            if (result.usage?.inputTokens !== undefined) usageDetails.input = result.usage.inputTokens;
            if (result.usage?.outputTokens !== undefined) usageDetails.output = result.usage.outputTokens;
            if (result.usage?.totalTokens !== undefined) usageDetails.total = result.usage.totalTokens;
            if (Object.keys(usageDetails).length > 0) body.usageDetails = usageDetails;
            // 费用仅在调用方明确提供时上报；不从模型名称或价格表推算。
            if (result.usage?.totalCost !== undefined) body.costDetails = { total: result.usage.totalCost };
          }
          this.events.push({
            id: randomUUID(),
            type: type === 'span' ? 'span-create' : 'generation-create',
            timestamp: nowIso(this.now),
            body,
          });
        } catch {
          // 跟踪故障不影响主流程。
        }
      },
    };
  }

  private async sendPending(): Promise<void> {
    if (this.events.length === 0) return;
    const batch = this.events.splice(0, this.events.length);
    for (const state of this.traces.values()) {
      if (batch.some(({ id }) => id === state.event.id)) state.sent = true;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      await this.fetchImpl(`${this.options.baseURL.replace(/\/+$/u, '')}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.options.publicKey}:${this.options.secretKey}`).toString('base64')}`,
        },
        body: JSON.stringify({ batch }),
        signal: controller.signal,
      });
    } catch {
      // 尽力上报：失败批次丢弃，不重放、不阻塞、不影响主流程。
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** 配置驱动的工厂：默认关闭；显式启用但缺少环境变量凭据时在启动阶段报错。 */
export function createLangfuseTracer(options: {
  config: { observability?: { langfuse: { enabled: boolean; baseURL: string; publicKeyEnv: string; secretKeyEnv: string } } };
  env: NodeJS.ProcessEnv;
  sessionId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): LangfuseTracer | undefined {
  const langfuse = options.config.observability?.langfuse;
  if (langfuse === undefined || !langfuse.enabled) return undefined;
  const publicKey = options.env[langfuse.publicKeyEnv]?.trim();
  if (!publicKey) throw new AgentError('CONFIG_ERROR', `缺少 Langfuse 凭据：请设置环境变量 ${langfuse.publicKeyEnv}。`);
  const secretKey = options.env[langfuse.secretKeyEnv]?.trim();
  if (!secretKey) throw new AgentError('CONFIG_ERROR', `缺少 Langfuse 凭据：请设置环境变量 ${langfuse.secretKeyEnv}。`);
  return new LangfuseTracer({
    baseURL: langfuse.baseURL,
    publicKey,
    secretKey,
    sessionId: options.sessionId,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** 在给定 scope 下创建子 span；没有跟踪或构造失败时返回 undefined。 */
export function childSpan(
  scope: TracingScope | undefined,
  options: { name: string; input?: unknown; metadata?: Record<string, unknown> },
): ObservationHandle | undefined {
  if (scope === undefined) return undefined;
  try {
    return scope.tracer.startSpan({
      traceId: scope.traceId,
      name: options.name,
      ...(scope.parentObservationId === undefined ? {} : { parentObservationId: scope.parentObservationId }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
  } catch {
    return undefined;
  }
}

/** 在给定 scope 下创建子 generation；没有跟踪或构造失败时返回 undefined。 */
export function childGeneration(
  scope: TracingScope | undefined,
  options: { name: string; model: string; input?: unknown; metadata?: Record<string, unknown>; modelParameters?: Record<string, unknown> },
): ObservationHandle | undefined {
  if (scope === undefined) return undefined;
  try {
    return scope.tracer.startGeneration({
      traceId: scope.traceId,
      name: options.name,
      model: options.model,
      ...(scope.parentObservationId === undefined ? {} : { parentObservationId: scope.parentObservationId }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.modelParameters === undefined ? {} : { modelParameters: options.modelParameters }),
    });
  } catch {
    return undefined;
  }
}

/** 以某个观察为父级构造子 scope；观察缺失时沿用原 scope。 */
export function childScope(scope: TracingScope | undefined, observation: ObservationHandle | undefined): TracingScope | undefined {
  if (scope === undefined) return undefined;
  return observation === undefined ? scope : { ...scope, parentObservationId: observation.id };
}
