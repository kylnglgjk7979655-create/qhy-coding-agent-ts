import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadTaskSkills } from '../.sandcastle/skills.js';
import { runReviewPhases } from '../.sandcastle/review-phases.js';

describe('仓库 skill 加载', () => {
  it('使用已提交的完整 skill 内容，引用文件指向控制脚本目录', async () => {
    const text = await loadTaskSkills('implement');
    const implementSpec = await readFile(new URL('../.agents/skills/implement-spec/SKILL.md', import.meta.url), 'utf8');
    expect(text).toContain(implementSpec);
    expect(await loadTaskSkills('implement-prd')).toContain(implementSpec);
    await expect(access(new URL('../.agents/skills/implement/SKILL.md', import.meta.url))).rejects.toThrow();
    const original = await readFile(new URL('../.agents/skills/tdd/SKILL.md', import.meta.url), 'utf8');
    expect(text).toContain(original); expect(text).toContain('tdd/tests.md'); expect(text).toContain('tdd/mocking.md');
    expect(text).toContain('diagnosing-bugs/scripts/hitl-loop.template.sh');
    expect(text).toContain('codebase-design/DEEPENING.md');
    expect(text).toContain(new URL('../.agents/skills/', import.meta.url).pathname);
  });
  it('拆票加载 to-tickets，架构加载共享设计方法', async () => {
    expect(await loadTaskSkills('to-issues')).toContain(await readFile(new URL('../.agents/skills/to-tickets/SKILL.md', import.meta.url), 'utf8'));
    expect(await loadTaskSkills('architecture')).toContain('Codebase Design');
    await expect(access(new URL('../.agents/skills/to-tickets-with-qa/SKILL.md', import.meta.url))).rejects.toThrow();
    await expect(access(new URL('../.agents/skills/improve-codebase-architecture-project/SKILL.md', import.meta.url))).rejects.toThrow();
    await expect(loadTaskSkills('unknown')).rejects.toThrow();
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
