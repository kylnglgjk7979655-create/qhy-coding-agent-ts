import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { workflowAgentStep } from './helpers/agent-workflow.js';

it.each(['qa', 'qa-only'])('%s 的门禁显示验收结果、原因和摘要；仅 pass 放行', async (stage) => {
  const root = await mkdtemp(join(tmpdir(), 'qa-verdict-'));
  try {
    await mkdir(join(root, stage));
    for (const verdict of ['pass', 'blocked', 'fail']) {
      const report = `# QA\n\nResult: **${verdict}**\n\nQ2：${verdict === 'blocked' ? '缺少真实 Actions 证据' : verdict === 'fail' ? '实际输出不符合 spec' : '全部必验项通过'}\n`;
      await writeFile(join(root, stage, 'verdict.txt'), verdict);
      await writeFile(join(root, stage, 'report.md'), report);
      const summary = join(root, `${verdict}-summary.md`);
      const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', workflowAgentStep(`agent-${stage}.yml`, 'Check QA verdict').script], {
        env: { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(verdict === 'pass' ? 0 : 1);
      expect(run.stdout).toContain(`QA verdict: ${verdict}`);
      expect(run.stdout).toContain(report);
      expect(await readFile(summary, 'utf8')).toBe(report);
      if (verdict !== 'pass') expect(run.stdout).toContain(`::error::QA ${verdict}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
