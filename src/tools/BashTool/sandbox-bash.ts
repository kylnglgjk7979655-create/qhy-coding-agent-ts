import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { ToolExecutionError } from '../tool-registry.js';
import { runBashProcess, runHostBash } from './host-bash.js';
import type { BashRunResult } from './host-bash.js';

const REJECTED_RESULT: BashRunResult = {
  stdout: '', stderr: '', exitCode: null, signal: null, truncated: false, sandboxed: false,
};

/**
 * 消费一次 Bash 调用已生成的沙箱计划：需要隔离时以 sandbox-exec 和计划给出的 profile、环境启动独立 shell，
 * 不进入沙箱时沿用宿主执行。无论成功、失败、超时还是取消，都清理本次调用的临时目录。
 */
export async function runPlannedBash(
  plan: SandboxPlan,
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<BashRunResult> {
  try {
    if (plan.mode === 'reject') {
      // fail-closed 不退回宿主执行；结果仍保留统一的 sandboxed 元信息与失败原因。
      throw new ToolExecutionError(plan.notice ?? '沙箱不可用，已拒绝执行。', withNotice(REJECTED_RESULT, plan.notice));
    }
    if (plan.mode === 'host') return withNotice(await runHostBash(command, cwd, signal, timeoutMs), plan.notice);

    // profile 只放在本次调用的 0700 目录内，避免暴露给其他用户或混入工作区。
    const profilePath = join(plan.tempDir, 'profile.sb');
    await writeFile(profilePath, plan.profile, { encoding: 'utf8', mode: 0o600 });
    const result = await runBashProcess(
      'sandbox-exec',
      ['-f', profilePath, 'bash', '--noprofile', '--norc', '-c', command],
      {
        cwd, env: plan.env, sandboxed: true,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
        startFailureMessage: '无法启动沙箱 Bash 命令。',
      },
    );
    return withNotice(result, plan.notice);
  } finally {
    await cleanupSandboxPlan(plan);
  }
}

/** 计划中的说明随结果返回给模型；未隔离或豁免结果不能被静默忽略。 */
function withNotice(result: BashRunResult, notice: string | undefined): BashRunResult {
  return notice === undefined ? result : { ...result, notice };
}
