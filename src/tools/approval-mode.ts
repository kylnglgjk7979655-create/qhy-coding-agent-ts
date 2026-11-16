import type { ApprovalMode, ResolvedConfig } from '../services/settings/config.js';
import type { ApprovalControl } from './tool-approval.js';

/** 当前 CLI 进程的审批模式；初始值来自 settings 或启动参数，切换不改写 settings。 */
export interface ApprovalModeState {
  current(): ApprovalMode;
  switchTo(mode: ApprovalMode): void;
}

export function createApprovalModeState(initial: ApprovalMode): ApprovalModeState {
  let mode = initial;
  return {
    current: () => mode,
    switchTo: (next) => { mode = next; },
  };
}

export function approvalModeLabel(mode: ApprovalMode): string {
  return mode === 'default' ? 'default（人工审批）' : 'auto（模型审批）';
}

export interface ApprovalModeCommand {
  /** 命令给出的新模式；省略表示只查看当前模式。 */
  readonly mode?: ApprovalMode;
  /** 无法识别的参数；原样展示给用户。 */
  readonly invalid?: string;
}

/**
 * 解析审批模式会话命令：`/permission-mode` 查看当前模式，`/permission-mode default|auto` 切换。
 * 启动参数与 Claude Code 的 `--permission-mode` 同名，但模式取值沿用本项目的审批语义。
 */
export function parseApprovalModeCommand(input: string): ApprovalModeCommand | undefined {
  const match = /^\/permission-mode(?:\s+(.*))?$/u.exec(input.trim());
  if (!match) return undefined;
  const argument = match[1]?.trim() ?? '';
  if (argument === '') return {};
  if (argument === 'default' || argument === 'auto') return { mode: argument };
  return { invalid: argument };
}

/** 只为本次审批判定替换模式，不修改配置对象或写入会话记录。 */
export function configWithApprovalMode(config: ResolvedConfig, mode: ApprovalMode): ResolvedConfig {
  if (config.approval.mode === mode) return config;
  return { ...config, approval: { ...config.approval, mode } };
}

/**
 * default 模式优先使用 CLI 人工控制，并保留公共入口的通用控制；auto 模式只使用通用控制，
 * 未提供时请求模型审批。运行时切换后，人工控制不能被当作模型审查复用。
 */
export function selectApprovalControl(
  mode: ApprovalMode,
  approvalControl: ApprovalControl | undefined,
  humanApprovalControl: ApprovalControl | undefined,
): ApprovalControl | undefined {
  return mode === 'default' ? (humanApprovalControl ?? approvalControl) : approvalControl;
}

/**
 * 每次工具调用进入审批时读取当前模式，并解析本次判定使用的配置与控制。
 * 模式省略时沿用配置模式；返回的配置是仅用于本次判定的副本，不写回原配置或会话记录。
 */
export function resolveApproval(
  config: ResolvedConfig,
  approvalMode: (() => ApprovalMode) | undefined,
  approvalControl: ApprovalControl | undefined,
  humanApprovalControl: ApprovalControl | undefined,
): { config: ResolvedConfig; control: ApprovalControl | undefined } {
  const mode = approvalMode?.() ?? config.approval.mode;
  return {
    config: configWithApprovalMode(config, mode),
    control: selectApprovalControl(mode, approvalControl, humanApprovalControl),
  };
}
