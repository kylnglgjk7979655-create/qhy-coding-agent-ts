import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runControlledProcess } from '../../services/process/controlled-process.js';
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
  timeoutMs?: number;
  sandboxed: boolean;
  /** 无法启动子进程时的提示；宿主与沙箱使用不同措辞。 */
  startFailureMessage?: string;
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
 * 启动一次 Bash 子进程并收集受限输出；宿主与沙箱执行共用进程组、超时和取消语义。
 * 调用方负责在审批后确认 cwd 未变化。
 */
export async function runBashProcess(
  file: string,
  args: string[],
  options: BashProcessOptions,
): Promise<BashRunResult> {
  const { cwd, env, signal, timeoutMs = 30_000, sandboxed } = options;
  signal?.throwIfAborted();
  if (process.platform === 'win32') throw new Error('宿主 Bash 需要支持 POSIX 进程组的系统。');
  try {
    // 审批可能等待很久；已展示的实际目录不能在此期间变成指向其他位置的链接。
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error();
  } catch {
    throw new Error('Bash 工作目录在审批后不可用或发生变化，请重新提交调用。');
  }
  signal?.throwIfAborted();
  const controlled = await runControlledProcess(file, args, {
    cwd,
    ...(env === undefined ? {} : { env }),
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
    // 沿用外部约定：stdout 与 stderr 合计最多保存 64 KiB。
    stdoutLimitBytes: 65_536,
    stderrLimitBytes: 65_536,
    combinedLimitBytes: 65_536,
  });
  const result: BashRunResult = {
    stdout: controlled.stdout,
    stderr: controlled.stderr,
    exitCode: controlled.exitCode,
    signal: controlled.signal,
    truncated: controlled.stdoutTruncated || controlled.stderrTruncated,
    sandboxed,
  };
  if (signal?.aborted) throw signal.reason;
  if (controlled.timedOut) throw new ToolExecutionError('Bash 命令执行超时。', result);
  if (controlled.startFailed) throw new ToolExecutionError(options.startFailureMessage ?? '无法启动 Bash 命令。', result);
  if (controlled.exitCode === 0) return result;
  if (sandboxed && /operation not permitted/iu.test(result.stderr)) {
    throw new ToolExecutionError('Bash 命令被沙箱策略拦截（Operation not permitted），而非命令本身错误。', result);
  }
  throw new ToolExecutionError('Bash 命令执行失败。', result);
}
