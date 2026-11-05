import { codex } from '@ai-hero/sandcastle';
import { describe, expect, it, vi } from 'vitest';
import { withCodexDiagnostics } from '../.sandcastle/codex-diagnostics.js';
describe('Codex 启动错误诊断', () => {
  it('报告 stdout 中真正的模型错误，去重连续重复消息并保留原始解析行为', () => {
    const provider = codex('test'); const report = vi.fn(); const wrapped = withCodexDiagnostics(provider, report);
    const error = JSON.stringify({ type: 'error', message: 'model unsupported' });
    expect(wrapped.parseStreamLine(error)).toEqual(provider.parseStreamLine(error));
    wrapped.parseStreamLine(JSON.stringify({ type: 'turn.failed', error: { message: 'model unsupported' } }));
    expect(report).toHaveBeenCalledExactlyOnceWith('Codex: model unsupported');
    wrapped.parseStreamLine(JSON.stringify({ type: 'turn.failed', error: { message: 'another error' } }));
    expect(report).toHaveBeenCalledTimes(2);
  });
  it('普通消息、无效 JSON 和 null 不影响原始解析', () => {
    const provider = codex('test'); const report = vi.fn(); const wrapped = withCodexDiagnostics(provider, report);
    for (const line of ['null', 'text', '{}', '{', JSON.stringify({ type: 'thread.started', thread_id: 'id' })]) {
      expect(wrapped.parseStreamLine(line)).toEqual(provider.parseStreamLine(line));
    }
    expect(report).not.toHaveBeenCalled();
  });
});
