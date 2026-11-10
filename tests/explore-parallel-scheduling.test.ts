import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

const search = vi.hoisted(() => ({
  validateSearchRoot: vi.fn(),
  globWorkspace: vi.fn(),
  grepWorkspace: vi.fn(),
}));

vi.mock('../src/tools/workspace-search.js', () => search);

const { runExplore } = await import('../src/query/explore.js');

describe('Explore 只读工具并发调度', () => {
  let workspace: string;
  let closeFixture: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeFixture?.();
    closeFixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    search.validateSearchRoot.mockReset();
    search.globWorkspace.mockReset();
    search.grepWorkspace.mockReset();
  });

  it('并行执行独立搜索并等待整批结果后再请求报告', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-parallel-'));
    let active = 0;
    let peakActive = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    search.validateSearchRoot.mockResolvedValue(undefined);
    const waitForPeer = async (): Promise<void> => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      started += 1;
      if (started === 2) releaseGate();
      if (started === 2) release();
      try { await gate; } finally { active -= 1; }
    };
    search.globWorkspace.mockImplementation(async () => {
      await waitForPeer();
      return { paths: ['module.ts'], truncated: false };
    });
    search.grepWorkspace.mockImplementation(async () => {
      await waitForPeer();
      return { matches: [{ path: 'module.ts', line: 1, text: 'answer' }], truncated: false };
    });
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [
        { id: 'parallel-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.ts' }) } },
        { id: 'parallel-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'answer' }) } },
      ] }
      : index === 2 ? { content: 'module.ts 中找到 answer；两项搜索均已完成。' } : undefined);
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };
    const run = runExplore(config, '定位 answer', '找出定义及文件位置');
    const overlapped = await Promise.race([
      bothStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    releaseGate();

    const report = await run;

    expect(overlapped).toBe(true);
    expect(peakActive).toBe(2);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]!.messages[0]!.content).toContain('无依赖的搜索和读取尽量放在同一批');
    expect(report).toContain('两项搜索均已完成');
  });

  it('每个 Explore 最多运行十个调用，取消后不启动排队调用', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qhy-explore-cancel-'));
    let active = 0;
    let peakActive = 0;
    const started: string[] = [];
    let tenStarted!: () => void;
    const firstTenStarted = new Promise<void>((resolve) => { tenStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    search.validateSearchRoot.mockResolvedValue(undefined);
    const waitForRelease = async (id: string): Promise<void> => {
      started.push(id);
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (started.length === 10) tenStarted();
      try { await gate; } finally { active -= 1; }
    };
    search.globWorkspace.mockImplementation(async ({ pattern }: { pattern: string }) => {
      await waitForRelease(pattern);
      return { paths: [], truncated: false };
    });
    search.grepWorkspace.mockImplementation(async ({ pattern }: { pattern: string }) => {
      await waitForRelease(pattern);
      return { matches: [], truncated: false };
    });
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: Array.from({ length: 11 }, (_, call) => ({
        id: `queued-${call}`,
        type: 'function' as const,
        function: call % 2 === 0
          ? { name: 'glob', arguments: JSON.stringify({ pattern: `glob-${call}` }) }
          : { name: 'grep', arguments: JSON.stringify({ pattern: `grep-${call}` }) },
      })) }
      : { content: '调查已完成。' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 5000, maxSteps: 4,
    };
    const cancellation = new AbortController();
    const run = runExplore(config, '批量搜索', '并行执行搜索', undefined, cancellation.signal);
    const capacityReached = await Promise.race([
      firstTenStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    cancellation.abort();
    release();

    await expect(run).rejects.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(capacityReached).toBe(true);
    expect(peakActive).toBe(10);
    expect(started).toHaveLength(10);
    expect(fixture.requests).toHaveLength(1);
  });
});
