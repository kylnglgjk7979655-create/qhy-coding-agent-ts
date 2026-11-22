import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startControlledProcess } from '../../services/process/controlled-process.js';
import type { ControlledProcessHandle, ControlledProcessResult } from '../../services/process/controlled-process.js';
import { isWithinWorkspace } from '../workspace-files.js';
import { ToolExecutionError } from '../tool-registry.js';
import { analyzeBashCommand } from './bash-policy.js';

export interface BashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  /** 本次调用是否在操作系统沙箱内执行；沙箱关闭或不可用时为 false。 */
  sandboxed: boolean;
  /** 需要向模型说明的执行状态；例如沙箱不可用时明确标注“未隔离执行”。 */
  notice?: string;
}

export interface BashProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 只在启动阶段生效的取消信号；交给作业层接管后不再绑定轮次。 */
  startupSignal?: AbortSignal;
  /** 进程层超时；`null` 表示由调用方计时（前后台切换的作业）。 */
  timeoutMs?: number | null;
  sandboxed: boolean;
  /** 无法启动子进程时的提示；宿主与沙箱使用不同措辞。 */
  startFailureMessage?: string;
  /** 作业模式：子进程退出后回收同进程组的残留成员。 */
  reapGroupOnExit?: boolean;
  /** 作业模式：额外保留每路最近输出，供 `/task` 在超过保存上限后继续显示。 */
  recentOutputLimitBytes?: number;
}

export async function prepareBashInput<Input extends { command: string; cwd?: string | undefined }>(workspace: string, input: Input) {
  try {
    const requestedCwd = input.cwd ?? '.';
    const cwd = await realpath(resolve(workspace, requestedCwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error();
    const analysis = analyzeBashCommand(input.command);
    // 重定向、管道等复合语法与工作区外 cwd 都要求额外审批。
    const requiresExtraApproval = analysis.requiresApproval || !isWithinWorkspace(resolve(workspace), cwd);
    return {
      input: { ...input, cwd, requestedCwd, approvedCwd: cwd },
      // 展示字段保持原形状；策略事实单独提供，审批不再解析这些字符串。
      details: {
        cwd,
        bashCommands: JSON.stringify(analysis.commands),
        bashRequiresApproval: String(requiresExtraApproval),
      },
      permission: { tool: 'Bash' as const, commands: analysis.commands, requiresExtraApproval },
    };
  } catch {
    throw new Error('Bash 命令或工作目录无效、无法可靠解析，或无法访问。');
  }
}

export async function verifyBashWorkingDirectory(workspace: string, requestedCwd: string, approvedCwd: string): Promise<void> {
  const current = await realpath(resolve(workspace, requestedCwd));
  if (current !== approvedCwd || !(await stat(current)).isDirectory()) {
    throw new Error('Bash 工作目录在审批期间发生变化，请重新提交调用。');
  }
}

/** 宿主 Bash 沿用当前用户环境启动独立 shell；结果显式标记未隔离。 */
export async function runHostBash(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<BashRunResult> {
  return runBashProcess('bash', ['--noprofile', '--norc', '-c', command], {
    cwd,
    sandboxed: false,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });
}

/**
 * 启动一次 Bash 子进程并立即返回句柄；宿主与沙箱执行共用进程组、超时和取消语义。
 * 调用方负责在审批后确认 cwd 未变化。前后台切换的作业在此基础上管理可暂停的前台时限。
 */
export async function startBashProcess(
  file: string,
  args: string[],
  options: BashProcessOptions,
): Promise<ControlledProcessHandle> {
  const { cwd, env, signal, startupSignal, timeoutMs = 30_000 } = options;
  signal?.throwIfAborted();
  startupSignal?.throwIfAborted();
  if (process.platform === 'win32') throw new Error('宿主 Bash 需要支持 POSIX 进程组的系统。');
  try {
    // 审批可能等待很久；已展示的实际目录不能在此期间变成指向其他位置的链接。
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Bash 工作目录在审批后不可用或发生变化，请重新提交调用。');
  }
  signal?.throwIfAborted();
  // 取消可能发生在 cwd 检查的 await 期间；spawn 前再确认，避免审批后取消仍然启动命令。
  startupSignal?.throwIfAborted();
  return startControlledProcess(file, args, {
    cwd,
    ...(env === undefined ? {} : { env }),
    ...(signal === undefined ? {} : { signal }),
    ...(startupSignal === undefined ? {} : { startupSignal }),
    timeoutMs,
    ...(options.reapGroupOnExit === true ? { reapGroupOnExit: true } : {}),
    ...(options.recentOutputLimitBytes === undefined ? {} : { recentOutputLimitBytes: options.recentOutputLimitBytes }),
    // 沿用外部约定：stdout 与 stderr 合计最多保存 64 KiB。
    stdoutLimitBytes: 65_536,
    stderrLimitBytes: 65_536,
    combinedLimitBytes: 65_536,
  });
}

/** 把受控进程结果映射为 Bash 工具可见的稳定形状。 */
export function bashRunResult(controlled: ControlledProcessResult, sandboxed: boolean): BashRunResult {
  return {
    stdout: controlled.stdout,
    stderr: controlled.stderr,
    exitCode: controlled.exitCode,
    signal: controlled.signal,
    truncated: controlled.stdoutTruncated || controlled.stderrTruncated,
    sandboxed,
  };
}

/**
 * 按统一语义判定 Bash 调用失败原因；成功时返回 undefined。
 * 前后台共用该判定，确保两种入口返回相同错误文案。
 */
export function bashFailureMessage(
  controlled: ControlledProcessResult,
  sandboxed: boolean,
  result: BashRunResult,
  startFailureMessage?: string,
): string | undefined {
  if (controlled.timedOut) return 'Bash 命令执行超时。';
  if (controlled.startFailed) return startFailureMessage ?? '无法启动 Bash 命令。';
  if (controlled.exitCode === 0) return undefined;
  if (sandboxed && /operation not permitted/iu.test(result.stderr)) {
    return 'Bash 命令被沙箱策略拦截（Operation not permitted），而非命令本身错误。';
  }
  return 'Bash 命令执行失败。';
}

/**
 * 启动一次 Bash 子进程并等待完成；失败时抛出携带输出与状态的 ToolExecutionError。
 * 调用方负责在审批后确认 cwd 未变化。
 */
export async function runBashProcess(
  file: string,
  args: string[],
  options: BashProcessOptions,
): Promise<BashRunResult> {
  const { signal, sandboxed } = options;
  const handle = await startBashProcess(file, args, options);
  const controlled = await handle.completion;
  const result = bashRunResult(controlled, sandboxed);
  if (signal?.aborted) throw signal.reason;
  const failure = bashFailureMessage(controlled, sandboxed, result, options.startFailureMessage);
  if (failure !== undefined) throw new ToolExecutionError(failure, result);
  return result;
}
