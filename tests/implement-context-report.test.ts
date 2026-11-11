import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflowOutput = vi.hoisted(() => ({ iterations: [] as unknown[], outputDir: '' }));
workflowOutput.outputDir = mkdtempSync(join(tmpdir(), 'implement-context-report-'));
afterAll(() => rmSync(workflowOutput.outputDir, { recursive: true, force: true }));

vi.mock('@ai-hero/sandcastle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-hero/sandcastle')>();
  return { ...actual, run: vi.fn(async () => ({ iterations: workflowOutput.iterations, commits: [] })) };
});

vi.mock('../.sandcastle/agent-workflows/shared/common.js', () => ({
  required: (name: string) => ({ ISSUE_NUMBER: '105', ISSUE_TITLE: '上下文窗口 返回失败', BRANCH: 'agent/issue-105' })[name],
  gh: () => 'issue context',
  codexAgent: () => ({}),
  outputDir: () => workflowOutput.outputDir,
  sh: () => '1',
  fail: (message: string) => { throw new Error(message); },
}));

vi.mock('../.sandcastle/agent-workflows/shared/pr-metadata.js', () => ({ publishPrMetadata: vi.fn() }));

describe('Actions 上下文用量汇报', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function report(iterations: unknown[]) {
    vi.resetModules();
    workflowOutput.iterations = iterations;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('../.sandcastle/agent-workflows/implement/implement.js');
    const reportLine = log.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith('Codex 上下文用量'));
    log.mockRestore();
    return reportLine;
  }

  it('最后一次迭代缺数据时报告最近一次有数据的请求及其迭代', async () => {
    await expect(report([
      { contextWindow: { tokens: 1200, limit: 4000 } },
      {},
    ])).resolves.toBe('Codex 上下文用量（第 1/2 次迭代的最后一次模型请求）：1,200 / 4,000 tokens (30.0%)');
  });

  it('上限缺失时只报告实际 token 数，全部缺失时明确显示不可用', async () => {
    await expect(report([
      { contextWindow: { tokens: 1200, limit: 4000 } },
      { contextWindow: { tokens: 2500 } },
    ])).resolves.toBe('Codex 上下文用量（第 2/2 次迭代的最后一次模型请求）：2,500 tokens');

    await expect(report([{}, {}])).resolves.toBe('Codex 上下文用量：上游未提供上下文窗口数据。');
  });
});
