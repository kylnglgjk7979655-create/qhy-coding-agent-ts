import type { ToolApprovalRequest } from '../tools/tool-registry.js';

export type ApprovalChoice = 'approve-once' | 'deny-once' | 'always-tool';

export interface ApprovalOption {
  choice: ApprovalChoice;
  label: string;
}

/**
 * 交互审批选项。只有工具默认审批才提供“本会话始终批准”；
 * 显式 ask 或范围规则每次都要重新确认，避免会话批准扩大规则范围。
 */
export function approvalOptionsFor(call: ToolApprovalRequest): ApprovalOption[] {
  const options: ApprovalOption[] = [
    { choice: 'approve-once', label: '批准本次' },
    { choice: 'deny-once', label: '拒绝本次' },
  ];
  if (call.approvalKind === 'default') {
    options.push({ choice: 'always-tool', label: `本会话始终批准 ${call.toolName}（仅跳过默认审批）` });
  }
  return options;
}

/**
 * 会话批准按工具名隔离，只存在当前进程内；退出后自然失效。
 * deny 在进入审批前已由固定规则拦截，显式 ask 会带 approvalKind='explicit' 再次询问。
 */
export class SessionApprovals {
  private readonly tools = new Set<string>();

  canSkipPrompt(call: ToolApprovalRequest): boolean {
    return call.approvalKind === 'default' && this.tools.has(call.toolName);
  }

  remember(toolName: string): void {
    this.tools.add(toolName);
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }
}