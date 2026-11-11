import { describe, expect, it, vi } from 'vitest';

vi.mock('../.sandcastle/codex-auth.js', () => ({
  codexAuthEnvironment: vi.fn(() => ({})),
  resolveCodexModel: vi.fn(() => 'fixture-model'),
}));

describe('Codex 上下文窗口采集', () => {
  it('从 Codex JSONL token_count 事件读取最后一次模型调用用量与上限', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 3210 },
          model_context_window: 128000,
        },
      },
    });

    expect(agent.parseStreamLine(line)).toContainEqual({
      type: 'context_window', contextWindow: { tokens: 3210, limit: 128000 },
    });
  });

  it('对缺少有效用量的事件不生成上下文数据', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();

    expect(agent.parseStreamLine(JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {} } },
    }))).toEqual([]);
  });

  it('上游未给模型上限时保留请求 token 数且不补造上限', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();

    expect(agent.parseStreamLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3210 } } },
    }))).toContainEqual({ type: 'context_window', contextWindow: { tokens: 3210 } });
  });
});
