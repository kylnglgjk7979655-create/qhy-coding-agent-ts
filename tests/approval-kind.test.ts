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
});