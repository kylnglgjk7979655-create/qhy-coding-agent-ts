import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../', import.meta.url));

/** 执行 workflow 中的真实 shell 入口，避免只测 TS runner 而漏掉 checkout/CWD 错配。 */
export function workflowAgentStep(workflow: string, name: string): { script: string; workingDirectory: string | undefined } {
  const source = readFileSync(join(repository, '.github/workflows', workflow), 'utf8');
  const block = source.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  if (!block) throw new Error(`缺少 workflow step：${name}`);
  const run = block.match(/^        run: (.+)$/mu)?.[1];
  if (!run) throw new Error(`缺少 shell 入口：${name}`);
  return {
    script: run === '|' ? block.split('        run: |\n')[1]!.split('\n').map((line) => line.slice(10)).join('\n') : run,
    workingDirectory: block.match(/^        working-directory: (.+)$/mu)?.[1],
  };
}

/** runner 与被测仓库分开；只提供真实 TS loader，Codex/GitHub 继续使用本地夹具。 */
export async function trustedRuntime(directory: string): Promise<string> {
  const runtime = join(directory, 'trusted');
  const bin = join(runtime, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  for (const folder of ['.sandcastle', '.agents']) {
    await symlink(join(repository, folder), join(runtime, folder), 'dir');
  }
  await writeFile(join(bin, 'tsx'), `#!/usr/bin/env node
const result = require('node:child_process').spawnSync(process.execPath, ['--import', ${JSON.stringify(require.resolve('tsx'))}, ...process.argv.slice(2)], {stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return runtime;
}
