import { AgentError } from '../../utils/errors.js';

/**
 * OpenAI 兼容接口的 fetch 适配器。工具事件在批次完成并通过原始调用 ID
 * 预检前暂存，避免 SDK 在预检失败前启动其中的任何工具。
 */
export async function validatedOpenAIFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return response;

  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const held: string[] = [];
  let pending = '';
  let collecting = false;
  let emittedThisPull = 0;
  const batch = new Map<number, { id: string; argumentsText: string; argumentsComplete: boolean }>();
  const batchIds = new Set<string>();

  function consumePendingEvents(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
    let boundary: number;
    while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
      const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)![0];
      processEvent(pending.slice(0, boundary + separator.length), controller);
      pending = pending.slice(boundary + separator.length);
    }
    return emittedThisPull > 0;
  }

  function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: string): void {
    controller.enqueue(encoder.encode(event));
    emittedThisPull += 1;
  }

  function processEvent(event: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const data = event.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!data || data === '[DONE]') {
      if (collecting) held.push(event);
      else enqueue(controller, event);
      return;
    }

    let payload: unknown;
    try { payload = JSON.parse(data); } catch {
      if (collecting) held.push(event);
      else enqueue(controller, event);
      return;
    }

    const choices = payload && typeof payload === 'object' && 'choices' in payload && Array.isArray(payload.choices) ? payload.choices : [];
    let hasToolDelta = false;
    let completedTools = false;
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      if ('delta' in choice && choice.delta && typeof choice.delta === 'object' && 'tool_calls' in choice.delta && Array.isArray(choice.delta.tool_calls)) {
        hasToolDelta = true;
        for (const item of choice.delta.tool_calls) {
          if (!item || typeof item !== 'object' || typeof item.index !== 'number') {
            throw new AgentError('PROVIDER_ERROR', '工具批次包含无法识别的调用项，已在执行前终止。');
          }
          const existing = batch.get(item.index);
          const functionDelta = 'function' in item && item.function && typeof item.function === 'object'
            ? item.function as Record<string, unknown>
            : undefined;
          const argumentFragment = typeof functionDelta?.arguments === 'string' ? functionDelta.arguments : '';
          if (existing) {
            if ('id' in item && item.id !== existing.id) {
              throw new AgentError('PROVIDER_ERROR', '同一调用索引出现不同原始 ID，已在执行前终止。');
            }
            if (existing.argumentsComplete && typeof functionDelta?.name === 'string') {
              throw new AgentError('PROVIDER_ERROR', '完整工具参数后出现重复的调用起始帧，已在执行前终止。');
            }
            if (argumentFragment) {
              existing.argumentsText += argumentFragment;
              try { JSON.parse(existing.argumentsText); existing.argumentsComplete = true; } catch { existing.argumentsComplete = false; }
            }
            continue;
          }

          const id = typeof item.id === 'string' ? item.id : undefined;
          if (!id?.trim()) {
            throw new AgentError('PROVIDER_ERROR', '工具调用首次出现时缺少原始调用 ID，已在执行前终止。');
          }
          if (batchIds.has(id)) {
            throw new AgentError('PROVIDER_ERROR', '工具批次包含重复调用 ID，已在执行前终止。');
          }
          const argumentsText = argumentFragment;
          let argumentsComplete = false;
          if (argumentsText) {
            try { JSON.parse(argumentsText); argumentsComplete = true; } catch { /* 仍在接收参数分片。 */ }
          }
          batch.set(item.index, { id, argumentsText, argumentsComplete });
          batchIds.add(id);
        }
      }
      if ('finish_reason' in choice && (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop')) completedTools = true;
    }

    if (hasToolDelta) collecting = true;
    if (collecting) held.push(event);
    else enqueue(controller, event);
    if (completedTools) {
      const ids = [...batch.values()].map((item) => item.id);
      if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
        throw new AgentError('PROVIDER_ERROR', '工具批次包含缺失、空或重复的调用 ID，已在执行前终止。');
      }
      for (const item of held) enqueue(controller, item);
      held.length = 0;
      collecting = false;
      batch.clear();
      batchIds.clear();
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        emittedThisPull = 0;
        if (consumePendingEvents(controller)) return;
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            consumePendingEvents(controller);
            if (pending) processEvent(pending, controller);
            controller.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          if (consumePendingEvents(controller)) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });

  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
