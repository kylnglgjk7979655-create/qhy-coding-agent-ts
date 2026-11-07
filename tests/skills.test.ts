import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('仓库固定的 skill 原文', () => {
  it('全部文件与清单固定的校验值一致，避免不知情地修改内容', async () => {
    const manifest = JSON.parse(await readFile(new URL('../.agents/skills/UPSTREAM.json', import.meta.url), 'utf8')) as { sha256: Record<string, string> };
    for (const [path, hash] of Object.entries(manifest.sha256)) {
      const content = await readFile(new URL(`../.agents/skills/${path}`, import.meta.url));
      expect(createHash('sha256').update(content).digest('hex'), path).toBe(hash);
    }
  });
});
