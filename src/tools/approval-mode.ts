import { APPROVAL_MODES } from '../services/settings/config.js';
import type { ApprovalMode, ResolvedConfig } from '../services/settings/config.js';
import type { ApprovalControl } from './tool-approval.js';

/** 交互终端按 Shift+Tab 时的固定循环顺序。 */
export const APPROVAL_MODE_CYCLE = ['default', 'auto', 'plan'] as const;

/** plan 模式唯一可公布和执行的内置工具；旧名称及其他能力一律拒绝。 */
export const PLAN_MODE_TOOL_NAMES = ['Read', 'Glob', 'Grep'] as const;

export function isPlanModeToolAllowed(toolName: string): boolean {
  return (PLAN_MODE_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** plan 只公布只读工具；/context 估算与实际请求共用同一份过滤，避免口径漂移。 */
export function planModeTools<T>(tools: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => isPlanModeToolAllowed(name)));
}

/** 配置与启动参数共用的模式合法性判定，新增模式时只需改 APPROVAL_MODES。 */
export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** default 与 plan 都由人工确认需要审批的调用；plan 额外强制只读。 */
export function usesHumanApproval(mode: ApprovalMode): boolean {
  return mode === 'default' || mode === 'plan';
}

/** 当前 CLI 进程的审批模式；初始值来自 settings 或启动参数，切换不改写 settings。 */
export interface ApprovalModeState {
  current(): ApprovalMode;
  switchTo(mode: ApprovalMode): void;
  /** 按 default → auto → plan → default 循环，返回切换后的模式。 */
  cycle(): ApprovalMode;
}

export function createApprovalModeState(initial: ApprovalMode): ApprovalModeState {
  let mode = initial;
  const switchTo = (next: ApprovalMode): void => { mode = next; };
  return {
    current: () => mode,
    switchTo,
    cycle: () => {
      const index = APPROVAL_MODE_CYCLE.indexOf(mode as (typeof APPROVAL_MODE_CYCLE)[number]);
      switchTo(APPROVAL_MODE_CYCLE[(index + 1) % APPROVAL_MODE_CYCLE.length]!);
      return mode;
    },
  };
}

export function approvalModeLabel(mode: ApprovalMode): string {
  if (mode === 'plan') return 'plan（只读）';
  return mode === 'default' ? 'default（人工审批）' : 'auto（模型审批）';
}

export interface ApprovalModeCommand {
  /** 命令给出的新模式；省略表示只查看当前模式。 */
  readonly mode?: ApprovalMode;
  /** 无法识别的参数；原样展示给用户。 */
  readonly invalid?: string;
}

/**
 * 解析审批模式会话命令：`/permission-mode` 查看当前模式，`/permission-mode default|auto|plan` 切换。
 * 启动参数与 Claude Code 的 `--permission-mode` 同名，但模式取值沿用本项目的审批语义。
 */
export function parseApprovalModeCommand(input: string): ApprovalModeCommand | undefined {
  const match = /^\/permission-mode(?:\s+(.*))?$/u.exec(input.trim());
  if (!match) return undefined;
  const argument = match[1]?.trim() ?? '';
  if (argument === '') return {};
  if (isApprovalMode(argument)) return { mode: argument };
  return { invalid: argument };
}

/** 只为本次审批判定替换模式，不修改配置对象或写入会话记录。 */
export function configWithApprovalMode(config: ResolvedConfig, mode: ApprovalMode): ResolvedConfig {
  if (config.approval.mode === mode) return config;
  return { ...config, approval: { ...config.approval, mode } };
}

/**
 * default 与 plan 模式优先使用 CLI 人工控制，并保留公共入口的通用控制；auto 模式只使用
 * 通用控制，未提供时请求模型审批。运行时切换后，人工控制不能被当作模型审查复用。
 */
export function selectApprovalControl(
  mode: ApprovalMode,
  approvalControl: ApprovalControl | undefined,
  humanApprovalControl: ApprovalControl | undefined,
): ApprovalControl | undefined {
  return usesHumanApproval(mode) ? (humanApprovalControl ?? approvalControl) : approvalControl;
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
