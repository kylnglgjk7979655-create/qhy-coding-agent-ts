import { describe, expect, it } from 'vitest';
import { approvalOptionsFor, SessionApprovals } from '../src/cli/approval-policy.js';
import type { ToolApprovalRequest } from '../src/tools/tool-registry.js';

// 本组用例只断言审批选项与会话批准，权限事实不参与判断，使用中性占位。
const inertPermission: ToolApprovalRequest['permission'] = { tool: 'skill' };

function call(toolName: string, approvalKind?: 'default' | 'explicit'): ToolApprovalRequest {
  return {
    callId: `${toolName}-1`, toolName, input: {},
    permission: inertPermission,
    ...(approvalKind === undefined ? {} : { approvalKind }),
  };
}

describe('交互审批选项', () => {
  it('默认审批提供批准本次、拒绝本次和本会话始终批准当前工具', () => {
    const options = approvalOptionsFor(call('Bash', 'default'));

    expect(options.map(({ choice }) => choice)).toEqual(['approve-once', 'deny-once', 'always-tool']);
    expect(options.at(-1)?.label).toContain('本会话始终批准 Bash');
    expect(options.at(-1)?.label).toContain('仅跳过默认审批');
  });

  it('显式 ask 不提供会话批准选项', () => {
    const options = approvalOptionsFor(call('Bash', 'explicit'));

    expect(options.map(({ choice }) => choice)).toEqual(['approve-once', 'deny-once']);
  });

  it('缺少来源标记时不提供会话批准', () => {
    const options = approvalOptionsFor(call('Bash'));

    expect(options.map(({ choice }) => choice)).toEqual(['approve-once', 'deny-once']);
  });
});

describe('会话批准范围', () => {
  it('只跳过同一工具的 default 审批，不扩展到其他工具', () => {
    const approvals = new SessionApprovals();
    approvals.remember('Bash');

    expect(approvals.canSkipPrompt(call('Bash', 'default'))).toBe(true);
    expect(approvals.canSkipPrompt(call('read_file', 'default'))).toBe(false);
    expect(approvals.has('Bash')).toBe(true);
    expect(approvals.has('read_file')).toBe(false);
  });

  it('显式 ask 即使同工具已获会话批准仍然询问', () => {
    const approvals = new SessionApprovals();
    approvals.remember('Bash');

    expect(approvals.canSkipPrompt(call('Bash', 'explicit'))).toBe(false);
  });

  it('新实例不继承批准，等价于进程退出后失效', () => {
    const first = new SessionApprovals();
    first.remember('Bash');
    const second = new SessionApprovals();

    expect(second.canSkipPrompt(call('Bash', 'default'))).toBe(false);
  });
});