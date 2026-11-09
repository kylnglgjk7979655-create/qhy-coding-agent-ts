import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishPrMetadata } from '../.sandcastle/agent-workflows/shared/pr-metadata.js';

let root: string;
let metadata: string;
const body = '## Summary\n\n修复恢复流程。\n\n## Evidence\n\nBefore: 未记录。After: pnpm check 通过。\n\n## Merge Danger\n\nDoor: two-way; Blast Radius: CLI';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-metadata-'));
  metadata = join(root, 'pr-metadata.json'); vi.stubEnv('OUTPUT_DIR', root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('共享 PR 绑定父 Issue 的关闭指令，并保留 skill 的证据及风险说明', () => {
  writeFileSync(metadata, JSON.stringify({ prTitle: 'fix: 恢复会话', prDescription: body }));
  publishPrMetadata(metadata, 23);
  expect(readFileSync(join(root, 'pr_description.txt'), 'utf8')).toBe(`${body}\n\nCloses #23`);
  expect(readFileSync(join(root, 'pr_title.txt'), 'utf8')).toBe('fix: 恢复会话');
});

it('文案缺失、不完整或试图关闭无关 Issue 时拒绝发布', () => {
  expect(() => publishPrMetadata(metadata, 23)).toThrow();
  writeFileSync(metadata, JSON.stringify({ prTitle: 'fix: fixture', prDescription: '只有总结' }));
  expect(() => publishPrMetadata(metadata, 23)).toThrow('Summary');
  writeFileSync(metadata, JSON.stringify({ prTitle: 'fix: fixture', prDescription: `${body}\n\nCloses #24` }));
  expect(() => publishPrMetadata(metadata, 23)).toThrow('其他 Issue');
});
