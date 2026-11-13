import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 创建临时目录并返回解析后的真实路径。
 * macOS 的 $TMPDIR 位于 /var，本身是 /private/var 的符号链接，产品会把工作区解析成实际路径。
 */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}