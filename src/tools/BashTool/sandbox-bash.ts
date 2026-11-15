import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { formatSandboxViolations } from '../../services/sandbox/sandbox-network.js';
import type { SandboxNetwork } from '../../services/sandbox/sandbox-network.js';
import { ToolExecutionError } from '../tool-registry.js';
import { runBashProcess, runHostBash } from './host-bash.js';
import type { BashRunResult } from './host-bash.js';

const REJECTED_RESULT: BashRunResult = {
  stdout: '', stderr: '', exitCode: null, signal: null, truncated: false, sandboxed: false,
};

/**
 * 消费一次 Bash 调用已生成的沙箱计划：需要隔离时以 sandbox-exec 和计划给出的 profile、环境启动独立 shell，
 * 不进入沙箱时沿用宿主执行。无论成功、失败、超时还是取消，都关闭本次调用的代理并清理临时目录。
 */
export async function runPlannedBash(
  plan: SandboxPlan,
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  network?: SandboxNetwork,
): Promise<BashRunResult> {
  try {
    if (plan.mode === 'reject') {
      // fail-closed 不退回宿主执行；结果仍保留统一的 sandboxed 元信息与失败原因。
      throw new ToolExecutionError(plan.notice ?? '沙箱不可用，已拒绝执行。', withNotice(REJECTED_RESULT, plan.notice));
    }
    if (plan.mode === 'host') {
      return withViolations(withNotice(await runHostBash(command, cwd, signal, timeoutMs), plan.notice), network);
    }

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
    return withViolations(withNotice(result, plan.notice), network);
  } catch (error) {
    // 失败、超时与取消都通过 ToolExecutionError 携带已收集输出；违规原因同样要进入模型可见结果。
    throw withViolationOutput(error, network);
  } finally {
    try {
      await network?.close();
    } finally {
      await cleanupSandboxPlan(plan);
    }
  }
}

/** 计划中的说明随结果返回给模型；未隔离或豁免结果不能被静默忽略。 */
function withNotice(result: BashRunResult, notice: string | undefined): BashRunResult {
  return notice === undefined ? result : { ...result, notice };
}

/** 违规汇总只在本次调用确实产生拒绝时追加，空列表不改变原有输出。 */
function withViolations(result: BashRunResult, network: SandboxNetwork | undefined): BashRunResult {
  const summary = formatSandboxViolations(network?.violations ?? []);
  if (summary === undefined) return result;
  const separator = result.stderr === '' ? '' : '\n';
  return { ...result, stderr: `${result.stderr}${separator}${summary}` };
}

/** 命令失败时保留原错误类型与输出，同时把违规汇总附加到已收集的 stderr。 */
function withViolationOutput(error: unknown, network: SandboxNetwork | undefined): unknown {
  if (!(error instanceof ToolExecutionError) || !isBashRunResult(error.output)) return error;
  return new ToolExecutionError(error.message, withViolations(error.output, network));
}

function isBashRunResult(value: unknown): value is BashRunResult {
  return typeof value === 'object' && value !== null && 'stdout' in value && 'stderr' in value;
}
