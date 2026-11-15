import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { ResolvedConfig, SandboxConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { ToolApprovalRequest } from '../src/tools/tool-registry.js';

// 只有非 macOS 能稳定验证“沙箱不可用”路径；macOS 的真实 Seatbelt 探测由独立用例覆盖。
describe.skipIf(process.platform === 'darwin' || process.platform === 'win32')('沙箱不可用集成路径', () => {
  let workspace = '';
  let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = '';
  });

  async function setup(sandbox: Partial<SandboxConfig>, command: string) {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-unavailable-')));
    fixture = await startLocalOpenAIModel((_request, index) => index === 1
      ? { calls: [{ id: 'bash-unavailable', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }] }
      : { content: '不可用路径已处理。' });
    const approvals: ToolApprovalRequest[] = [];
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000 },
      permissions: { allow: [], ask: [], deny: [], sandbox: { ...DEFAULT_SANDBOX, enabled: true, ...sandbox } },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace, timeoutMs: 3000, maxSteps: 5,
    };
    await runAgent(config, '运行命令', {
      smokeTool: false,
      approvalControl: async (call) => {
        approvals.push(call);
        return 'approve';
      },
    });
    const toolOutput = fixture.requests[1]?.messages
      .filter(({ role }) => role === 'tool')
      .map(({ content }) => JSON.parse(content as string) as {
        is_error: boolean;
        error?: { code: string; message: string };
        output?: { stdout: string; sandboxed: boolean; notice?: string };
      })[0];
    return { approvals, toolOutput };
  }

  it('onUnavailable=open 时照常执行，工具结果与审批信息都标明未隔离', async () => {
    const command = 'printf sandbox-open > marker.txt';
    const { approvals, toolOutput } = await setup({ onUnavailable: 'open' }, command);

    expect(toolOutput).toMatchObject({
      is_error: false,
      output: { stdout: '', sandboxed: false, notice: expect.stringContaining('未隔离') },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.details?.sandboxNotice).toContain('未隔离');
    expect(await readFile(join(workspace, 'marker.txt'), 'utf8')).toBe('sandbox-open');
  });

  it('onUnavailable=closed 时拒绝执行，不产生命令副作用并说明原因', async () => {
    const command = 'printf sandbox-closed > marker.txt';
    const { approvals, toolOutput } = await setup({ onUnavailable: 'closed' }, command);

    expect(toolOutput).toMatchObject({
      is_error: true,
      error: { code: 'TOOL_EXECUTION_ERROR', message: expect.stringContaining('closed') },
      output: { sandboxed: false, notice: expect.stringContaining('closed') },
    });
    expect(toolOutput!.error!.message).toContain('拒绝');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.details?.sandboxNotice).toContain('closed');
    await expect(readFile(join(workspace, 'marker.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
