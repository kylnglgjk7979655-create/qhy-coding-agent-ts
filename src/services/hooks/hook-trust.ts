import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionStorageRoot } from '../session/conversations.js';
import { HOOK_EVENTS, type HooksConfig } from './hooks-config.js';

/** 信任记录只保存在 CLI 用户目录；工作区内的同名文件永远不会被读取。 */
const trustRecordVersion = 1;

export interface HookTrustRecord {
  version: typeof trustRecordVersion;
  /** 工作区 realpath → 该工作区已确认的 hooks 配置 hash。 */
  trusted: Record<string, string>;
}

export function trustRecordPath(home: string): string {
  return join(sessionStorageRoot(home), 'trusted.json');
}

/** 判断是否存在需要信任判断的 Hook；空事件数组和全空 matcher 组不触发门禁。 */
export function hasHookCommands(hooks: HooksConfig | undefined): hooks is HooksConfig {
  return hooks !== undefined
    && HOOK_EVENTS.some((event) => (hooks[event] ?? []).some((group) => group.hooks.length > 0));
}

/**
 * 只对 hooks 配置做规范化 JSON hash：
 * 对象键排序、剔除 undefined，数组保持配置顺序。
 * 无关 settings 不参与，因此修改模型、权限等配置不会触发重新确认。
 */
export function hooksConfigHash(hooks: HooksConfig): string {
  return createHash('sha256').update(canonicalJson(hooks)).digest('hex');
}

/** 完整命令清单，供交互终端首次信任确认展示；不遗漏事件、matcher 或超时设置。 */
export function formatHookCommandList(hooks: HooksConfig): string {
  const lines: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const group of hooks[event] ?? []) {
      const matcher = group.matcher === undefined || group.matcher === ''
        ? '全部'
        : group.matcher;
      for (const hook of group.hooks) {
        const timeout = hook.timeoutMs === undefined ? '' : `（timeoutMs ${hook.timeoutMs}）`;
        lines.push(`- [${event}] matcher ${matcher}：${hook.command}${timeout}`);
      }
    }
  }
  return lines.join('\n');
}

/** 读取失败、记录损坏或权限宽于 0600 时一律按未信任处理，避免被其他用户改写。 */
export async function isHooksConfigTrusted(
  home: string,
  workspace: string,
  hooks: HooksConfig,
): Promise<boolean> {
  const record = await readTrustRecord(home);
  return record.trusted[workspace] === hooksConfigHash(hooks);
}

/** 原子写入信任记录；目录 0700、文件 0600，先写临时文件再 rename。 */
export async function trustHooksConfig(
  home: string,
  workspace: string,
  hooks: HooksConfig,
): Promise<void> {
  const directory = sessionStorageRoot(home);
  const path = trustRecordPath(home);
  const record = await readTrustRecord(home);
  record.trusted[workspace] = hooksConfigHash(hooks);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(directory, `.trusted.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readTrustRecord(home: string): Promise<HookTrustRecord> {
  const path = trustRecordPath(home);
  try {
    const info = await lstat(path);
    // 拒绝符号链接与非常规文件，避免用户目录中的链接把工作区内容当成信任来源。
    if (!info.isFile() || info.isSymbolicLink()) return emptyRecord();
    // Windows 不提供 POSIX 权限位；其余平台拒绝组用户或其他人可读写的信任文件。
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) return emptyRecord();
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== trustRecordVersion || !isRecord(parsed.trusted)) {
      return emptyRecord();
    }
    const trusted: Record<string, string> = {};
    for (const [workspace, hash] of Object.entries(parsed.trusted)) {
      if (typeof hash === 'string') trusted[workspace] = hash;
    }
    return { version: trustRecordVersion, trusted };
  } catch {
    return emptyRecord();
  }
}

function emptyRecord(): HookTrustRecord {
  return { version: trustRecordVersion, trusted: {} };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}