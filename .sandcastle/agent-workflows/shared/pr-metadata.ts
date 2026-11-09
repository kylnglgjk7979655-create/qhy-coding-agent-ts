import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeText } from './common.js';

const metadataSchema = z.object({
  prTitle: z.string().trim().min(1).max(70).refine((title) => !/[\r\n]/u.test(title), 'PR 标题必须为单行。'),
  prDescription: z.string().trim().min(1).max(60_000),
}).strict();

/** 验证 skill 的交付物，并由脚本绑定唯一可自动关闭的需求。 */
export function publishPrMetadata(path: string, issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('无效 PR 关联 Issue。');
  const metadata = metadataSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const section of ['Summary', 'Evidence', 'Merge Danger']) {
    if (!new RegExp(`^## ${section}\\s*$`, 'mu').test(metadata.prDescription)) {
      throw new Error(`PR 正文缺少 pr skill 的 ${section} 部分。`);
    }
  }
  const closings = [...metadata.prDescription.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/giu)];
  if (closings.some((match) => Number(match[1]) !== issueNumber)) {
    throw new Error('PR 正文包含其他 Issue 的自动关闭指令。');
  }
  const body = closings.length ? metadata.prDescription : `${metadata.prDescription}\n\nCloses #${issueNumber}`;
  writeText('pr_title.txt', metadata.prTitle);
  writeText('pr_description.txt', body);
}
