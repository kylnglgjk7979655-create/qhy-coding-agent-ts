import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { formatSandboxViolations } from '../../services/sandbox/sandbox-network.js';
import type { SandboxNetwork } from '../../services/sandbox/sandbox-network.js';
import type { ControlledProcessHandle, ControlledProcessResult } from '../../services/process/controlled-process.js';
import { ToolExecutionError } from '../tool-registry.js';
import { bashFailureMessage, bashRunResult, startBashProcess } from './host-bash.js';
import type { BashRunResult } from './host-bash.js';

const REJECTED_RESULT: BashRunResult = {
  stdout: '', stderr: '', exitCode: null, signal: null, truncated: false, sandboxed: false,
};

export interface PlannedBashOptions {
  signal?: AbortSignal;
  /** 进程层超时；`null` 表示由作业层按前台预算计时。 */
  timeoutMs?: number | null;
}

/**
 * 已启动的 Bash 计划执行句柄。`completion` 在进程组结束且代理、临时目录清理完成后解析；
 * 调用方可在运行期间读取快照或终止进程组，用于后台作业与前后台切换。
 */
export interface PlannedBashExecution {
  readonly started: Promise<boolean>;
  readonly completion: Promise<ControlledProcessResult>;
  snapshot(): ControlledProcessResult;
  terminate(): void;
  /** 把受控进程结果转换为带沙箱说明和违规汇总的可展示结果。 */
  result(controlled: ControlledProcessResult): BashRunResult;
  /** 按统一语义返回失败文案；成功时省略。 */
  failureMessage(controlled: ControlledProcessResult): string | undefined;
}

/**
 * 启动一次 Bash 调用已生成的沙箱计划。拒绝计划在这里立即抛错，不启动任何进程；
 * 启动失败、超时、取消与正常结束都通过句柄的 completion 返回，资源随进程组生命周期清理。
 */
export async function startPlannedBash(
  plan: SandboxPlan,
  command: string,
  cwd: string,
  network: SandboxNetwork | undefined,
  options: PlannedBashOptions = {},
): Promise<PlannedBashExecution> {
  const { signal, timeoutMs = 30_000 } = options;
  if (plan.mode === 'reject') {
    // 拒绝计划同样要释放准备阶段启动的代理与临时目录。
    try {
      await network?.close();
    } finally {
      await cleanupSandboxPlan(plan);
    }
    // fail-closed 不退回宿主执行；结果仍保留统一的 sandboxed 元信息与失败原因。
    throw new ToolExecutionError(plan.notice ?? '沙箱不可用，已拒绝执行。', withNotice(REJECTED_RESULT, plan.notice));
  }

  let handle: ControlledProcessHandle;
  try {
    if (plan.mode === 'host') {
      handle = await startBashProcess('bash', ['--noprofile', '--norc', '-c', command], {
        cwd, sandboxed: false,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
      });
    } else {
      // profile 只放在本次调用的 0700 目录内，避免暴露给其他用户或混入工作区。
      const profilePath = join(plan.tempDir, 'profile.sb');
      await writeFile(profilePath, plan.profile, { encoding: 'utf8', mode: 0o600 });
      handle = await startBashProcess(
        'sandbox-exec',
        ['-f', profilePath, 'bash', '--noprofile', '--norc', '-c', command],
        {
          cwd, env: plan.env, sandboxed: true,
          ...(signal === undefined ? {} : { signal }),
          timeoutMs,
          startFailureMessage: '无法启动沙箱 Bash 命令。',
        },
      );
    }
  } catch (error) {
    // 启动前失败（例如审批期间目录变化）也必须释放代理与临时目录。
    try {
      await network?.close();
    } finally {
      await cleanupSandboxPlan(plan);
    }
    throw error;
  }

  const clearResources = async (): Promise<void> => {
    try {
      await network?.close();
    } finally {
      await cleanupSandboxPlan(plan);
    }
  };
  const completion = handle.completion.then(
    async (controlled) => { await clearResources(); return controlled; },
    async (error: unknown) => { await clearResources(); throw error; },
  );
  return {
    started: handle.started,
    completion,
    snapshot: handle.snapshot,
    terminate: handle.terminate,
    result: (controlled) => withViolations(withNotice(bashRunResult(controlled, plan.sandboxed), plan.notice), network),
    failureMessage: (controlled) => bashFailureMessage(
      controlled,
      plan.sandboxed,
      withViolations(withNotice(bashRunResult(controlled, plan.sandboxed), plan.notice), network),
      plan.mode === 'sandbox' ? '无法启动沙箱 Bash 命令。' : undefined,
    ),
  };
}

/**
 * 消费一次 Bash 调用已生成的沙箱计划并等待完成；失败时抛出携带已收集输出的 ToolExecutionError。
 * 需要前后台切换的调用方使用 startPlannedBash，两者共享进程、清理与错误语义。
 */
export async function runPlannedBash(
  plan: SandboxPlan,
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  network?: SandboxNetwork,
): Promise<BashRunResult> {
  const execution = await startPlannedBash(plan, command, cwd, network, {
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });
  const controlled = await execution.completion;
  const result = execution.result(controlled);
  if (signal?.aborted) throw signal.reason;
  const failure = execution.failureMessage(controlled);
  if (failure !== undefined) throw new ToolExecutionError(failure, result);
  return result;
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

