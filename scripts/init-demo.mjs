import { cp, lstat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.demo-workspace');

try {
  await lstat(target);
  throw new Error('.demo-workspace 已存在；为保护现有工作，不会覆盖。');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

await mkdir(target);
await cp(resolve(root, 'demo'), target, {
  recursive: true,
  filter: (source) => !source.split(/[\\/]/).some((part) => ['node_modules', '.git', 'dist'].includes(part)),
});

function git(args) {
  const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Git 执行失败。');
  return result.stdout.trim();
}

git(['init', '--initial-branch=main']);
git(['add', '.']);
git(['-c', 'user.name=Demo Fixture', '-c', 'user.email=demo@example.invalid', 'commit', '-m', 'demo: clean baseline with known discount bug']);
git(['tag', 'demo-start']);
if (git(['status', '--porcelain'])) throw new Error('演示仓库工作区不干净。');
console.log(`演示仓库：${target}\n干净起始提交：${git(['rev-parse', 'HEAD'])}\n标签：demo-start`);
