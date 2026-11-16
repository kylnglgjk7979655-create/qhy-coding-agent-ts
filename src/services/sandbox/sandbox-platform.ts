import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxPlatformProbe } from './sandbox-plan.js';

const run = promisify(execFile);
let cached: Promise<SandboxPlatformProbe> | undefined;

/**
 * 探测当前平台是否能使用 Seatbelt 沙箱。
 * 进程内只自检一次：不仅检查 macOS 平台，还要求最小 profile 能实际启动，避免把损坏的 sandbox-exec 当成可用。
 */
export function probeSandboxPlatform(): Promise<SandboxPlatformProbe> {
  cached ??= detectSeatbelt();
  return cached;
}

async function detectSeatbelt(): Promise<SandboxPlatformProbe> {
  if (process.platform !== 'darwin') return { seatbelt: false };
  try {
    await run('sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { timeout: 5_000 });
    return { seatbelt: true };
  } catch {
    return { seatbelt: false };
  }
}
