import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

/** 检测验收期间的提交和产品文件变化；QA 产物应写到仓库外。 */
export function readOnlySnapshot() {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const workingTree = git('status', '--porcelain=v1', '--untracked-files=all');
  const hash = createHash('sha256').update(head).update(workingTree)
    .update(git('diff', '--binary', 'HEAD'));
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    hash.update(file).update('\0');
    hash.update(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    hash.update('\0');
  }
  return { head, workingTree, fingerprint: hash.digest('hex') };
}
