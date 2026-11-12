import { describe, expect, it, vi } from 'vitest';

vi.mock('../.sandcastle/codex-auth.js', () => ({
  codexAuthEnvironment: vi.fn(() => ({})),
  resolveCodexModel: vi.fn(() => 'fixture-model'),
}));

describe('Codex 上下文窗口采集', () => {
  it('从 Codex rollout JSONL 读取最后一次模型调用用量与上限', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();
    const session = `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 3210 },
          model_context_window: 128000,
        },
      },
    })}\n`;

    expect(agent.parseSessionContextWindow?.(session)).toEqual({ tokens: 3210, limit: 128000 });
  });

  it('对缺少有效用量的 rollout 事件不生成上下文数据', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();

    expect(agent.parseSessionContextWindow?.(`${JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {} } },
    })}\n`)).toBeUndefined();
  });

  it('上游未给模型上限时只保留请求 token 数', async () => {
    const { codexAgent } = await import('../.sandcastle/agent-workflows/shared/common.js');
    const agent = codexAgent();

    expect(agent.parseSessionContextWindow?.(`${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3210 } } },
    })}\n`)).toEqual({ tokens: 3210 });
  });
});
