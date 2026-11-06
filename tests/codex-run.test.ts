import { afterEach, expect, it, vi } from 'vitest';
import { runCodex } from '../.sandcastle/codex-run.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('失败且无会话数据时仍报告模型和用量不可用，并保留原始错误', async () => {
  vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(runCodex('test-model', {}, async () => { throw new Error('启动失败'); })).rejects.toThrow('启动失败');
  expect(log.mock.calls.map(([message]) => message)).toEqual([
    'Codex 模型：test-model',
    'Codex 上下文：不可用（会话未提供上下文用量）',
  ]);
});
