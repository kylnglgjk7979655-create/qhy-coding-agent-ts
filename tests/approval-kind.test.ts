import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX, type ResolvedConfig } from '../src/services/settings/config.js';
import { approveToolCall } from '../src/tools/tool-approval.js';
import type { ToolApprovalRequest } from '../src/tools/tool-registry.js';

function config(permissions: NonNullable<ResolvedConfig['permissions']>): ResolvedConfig {
  return {
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    workspace: '/tmp/qhy-approval-kind', timeoutMs: 1000, maxSteps: 1,
    approval: { mode: 'default', timeoutMs: 1000, humanTimeoutMs: 1000 },
    permissions,
  };
}

function writeCall(toolName = 'write_file', callId = 'call-1'): ToolApprovalRequest {
  return {
    callId,
    toolName,
    input: { path: 'note.txt', content: 'content' },
    details: { requestedPath: 'note.txt', target: join('/tmp/qhy-approval-kind', 'note.txt') },
    permission: { tool: 'write_file', requestedPath: 'note.txt', target: join('/tmp/qhy-approval-kind', 'note.txt') },
  };
}

describe('人工审批来源标记', () => {
  it('工具默认审批标记为 default，供会话批准安全跳过', async () => {
    const seen: ToolApprovalRequest[] = [];
    const decision = await approveToolCall(
      config({ allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX }),
      writeCall(),
      new AbortController().signal,
      async (request) => { seen.push(request); return 'approve'; },
    );

    expect(decision).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.approvalKind).toBe('default');
  });

  it('显式 ask 规则标记为 explicit，会话批准不能跳过', async () => {
    const seen: ToolApprovalRequest[] = [];
    const decision = await approveToolCall(
      config({ allow: [], ask: ['Write'], deny: [], sandbox: DEFAULT_SANDBOX }),
      writeCall(),
      new AbortController().signal,
      async (request) => { seen.push(request); return 'deny'; },
    );

    expect(decision).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.approvalKind).toBe('explicit');
  });

  it('显式 deny 在进入审批控制前拒绝', async () => {
    const seen: ToolApprovalRequest[] = [];
    const decision = await approveToolCall(
      config({ allow: [], ask: [], deny: ['Write'], sandbox: DEFAULT_SANDBOX }),
      writeCall(),
      new AbortController().signal,
      async (request) => { seen.push(request); return 'approve'; },
    );

    expect(decision).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('Bash 默认审批标记 default，显式 Bash ask 标记 explicit', async () => {
    const bashCall: ToolApprovalRequest = {
      callId: 'bash-1', toolName: 'Bash', input: { command: 'echo hi' },
      details: { bashCommands: JSON.stringify(['echo hi']) },
      permission: { tool: 'Bash', commands: ['echo hi'], requiresExtraApproval: false },
    };
    const defaults: ToolApprovalRequest[] = [];
    await approveToolCall(
      config({ allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX }),
      bashCall,
      new AbortController().signal,
      async (request) => { defaults.push(request); return 'approve'; },
    );
    const asks: ToolApprovalRequest[] = [];
    await approveToolCall(
      config({ allow: [], ask: ['Bash(echo:*)'], deny: [], sandbox: DEFAULT_SANDBOX }),
      bashCall,
      new AbortController().signal,
      async (request) => { asks.push(request); return 'deny'; },
    );

    expect(defaults[0]?.approvalKind).toBe('default');
    expect(asks[0]?.approvalKind).toBe('explicit');
  });

  it('Hook allow 跳过工具默认审批，但不跳过网络工具默认审批', async () => {
    const permissions = { allow: [], ask: [], deny: [], sandbox: DEFAULT_SANDBOX };
    let writeApprovalRequested = false;
    const writeDecision = await approveToolCall(
      config(permissions),
      { ...writeCall(), hookPermission: { decision: 'allow', reason: 'Hook 允许' } },
      new AbortController().signal,
      async () => { writeApprovalRequested = true; return 'deny'; },
    );

    const seen: ToolApprovalRequest[] = [];
    const webDecision = await approveToolCall(
      config(permissions),
      {
        callId: 'web-1', toolName: 'WebFetch', input: { url: 'https://example.com', prompt: '读取' },
        permission: { tool: 'webFetch', hostname: 'example.com' },
        hookPermission: { decision: 'allow', reason: 'Hook 允许' },
      },
      new AbortController().signal,
      async (request) => { seen.push(request); return 'deny'; },
    );

    // 工具默认审批可被 Hook allow 跳过；网络工具的默认审批仍须进入审批。
    expect(writeDecision).toBe(true);
    expect(writeApprovalRequested).toBe(false);
    expect(webDecision).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
