import type { AgentProvider } from '@ai-hero/sandcastle';

// Sandcastle 0.14 优先显示 stderr；Codex 的真正错误可能位于 stdout JSON。
export function withCodexDiagnostics(agent: AgentProvider, report = console.error): AgentProvider {
  let lastMessage = '';
  return {
    ...agent,
    parseStreamLine(line) {
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown; error?: { message?: unknown } } | null;
        const message = event?.type === 'error' ? event.message : event?.type === 'turn.failed' ? event.error?.message : undefined;
        if (typeof message === 'string' && message && message !== lastMessage) {
          report(`Codex: ${message}`);
          lastMessage = message;
        }
      } catch { /* 普通文本继续交给 provider。 */ }
      return agent.parseStreamLine(line);
    },
  };
}
