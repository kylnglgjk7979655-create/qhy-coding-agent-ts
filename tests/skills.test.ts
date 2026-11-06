import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTaskPrompt } from '../.sandcastle/prompts.js';
import { runReviewPhases } from '../.sandcastle/review-phases.js';

describe('完整任务 prompt 与上游来源', () => {
  it('只复制模板也能构建所有任务，无需 skill 目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-prompts-'));
    try {
      await cp(new URL('../.sandcastle/prompts/', import.meta.url), root, { recursive: true });
      for (const mode of ['implement', 'bugfix', 'code-design', 'review', 'implement-pr', 'update-branch', 'to-issues', 'architecture']) {
        const prompt = await loadTaskPrompt(mode, pathToFileURL(`${root}/`));
        expect(prompt).toContain('<output>');
        expect(prompt).not.toContain('已加载的');
        expect(prompt).not.toMatch(/\]\((?:tests|mocking|DEEPENING|DESIGN-IT-TWICE)\.md\)/);
      }
      await expect(loadTaskPrompt('unknown')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('全部上游文件与锁定版本校验值一致，避免不知情地修改上游内容', async () => {
    const manifest = JSON.parse(await readFile(new URL('../.agents/skills/UPSTREAM.json', import.meta.url), 'utf8')) as { sha256: Record<string, string> };
    for (const [path, hash] of Object.entries(manifest.sha256)) {
      const content = await readFile(new URL(`../.agents/skills/${path}`, import.meta.url));
      expect(createHash('sha256').update(content).digest('hex'), path).toBe(hash);
    }
  });
});

describe('独立审查与修复阶段', () => {
  it('两个轴按顺序只读执行，修复阶段收到两份独立报告', async () => {
    const events: string[] = [];
    const result = await runReviewPhases({
      review: async (axis) => { events.push(axis); return `${axis}报告`; },
      assertReadOnly: async () => { events.push('verify'); },
      repair: async (reports) => { events.push('repair'); expect(reports).toEqual({ Standards: 'Standards报告', Spec: 'Spec报告' }); return 'result'; },
    });
    expect(events).toEqual(['Standards', 'verify', 'Spec', 'verify', 'repair']); expect(result).toBe('result');
  });
  it('只读审查修改代码或检查失败时不进入修复', async () => {
    const review = vi.fn().mockResolvedValue('报告'); const repair = vi.fn();
    await expect(runReviewPhases({ review, assertReadOnly: async () => { throw new Error('工作区已修改'); }, repair })).rejects.toThrow('已修改');
    expect(review).toHaveBeenCalledTimes(1); expect(repair).not.toHaveBeenCalled();
  });
});
