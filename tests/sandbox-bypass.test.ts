import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { ResolvedConfig, SandboxConfig } from '../src/services/settings/config.js';
import type { ToolApprovalRequest } from '../src/tools/tool-registry.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureToolCall } from './helpers/local-openai-fixture.js';

interface FixtureToolOutput {
  is_error: boolean;
  error?: { code: string; message: string };
  output?: { stdout: string; stderr: string; exitCode: number | null; sandboxed: boolean; notice?: string };
}

interface RunOptions {
  calls: FixtureToolCall[];
  sandbox?: Partial<SandboxConfig>;
  /** default 使用人工审批控制；auto 使用模型审批与本地审查夹具。 */
  mode?: 'default' | 'auto';
  rules?: { allow?: string[]; ask?: string[]; deny?: string[] };
}

let workspace = '';
let root = '';
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;
const originalEnv = { ...process.env };

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await fixture?.close();
  fixture = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  else if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = '';
  root = '';
});

async function run(options: RunOptions): Promise<{
  approvals: ToolApprovalRequest[];
  toolResults: FixtureToolOutput[];
  toolResult: FixtureToolOutput;
}> {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-bypass-')));
  fixture = await startLocalOpenAIModel(
    (_request, index) => index === 1 ? { calls: options.calls } : { content: '命令处理完成。' },
    () => ({ content: 'approve' }),
  );
  const config: ResolvedConfig = {
    approval: { mode: options.mode ?? 'default', rules: [], timeoutMs: 30_000, humanTimeoutMs: 30_000 },
    permissions: {
      allow: options.rules?.allow ?? [], ask: options.rules?.ask ?? [], deny: options.rules?.deny ?? [],
      sandbox: { ...DEFAULT_SANDBOX, enabled: true, ...options.sandbox },
    },
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    baseURL: fixture.baseURL, workspace, timeoutMs: 5000, maxSteps: 5,
  };
  const approvals: ToolApprovalRequest[] = [];
  const result = await runAgent(config, '运行命令', {
    smokeTool: false,
    ...(options.mode === 'auto' ? {} : {
      approvalControl: async (call) => {
        approvals.push(call);
        return 'approve';
      },
    }),
  });
  const toolResults = fixture.requests.at(-1)?.messages
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => JSON.parse(content as string) as FixtureToolOutput) ?? [];
  expect(result.text).toBeTruthy();
  return { approvals, toolResults, toolResult: toolResults[0]! };
}

function bash(id: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name: 'Bash', arguments: JSON.stringify(input) } };
}

describe('disableSandbox 参数', () => {
  it('沙箱关闭时仍接受参数且不影响宿主执行路径，审批标注已忽略', async () => {
    process.env.QHY_BYPASS_ENV = 'host-only';
    const { approvals, toolResult } = await run({
      calls: [bash('disabled', { command: 'printenv QHY_BYPASS_ENV', disableSandbox: true })],
      sandbox: { enabled: false },
    });

    expect(toolResult).toMatchObject({
      is_error: false,
      output: { stdout: 'host-only\n', exitCode: 0, sandboxed: false },
    });
    expect(toolResult.output).not.toHaveProperty('notice');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.input).toMatchObject({ command: 'printenv QHY_BYPASS_ENV', disableSandbox: true });
    expect(approvals[0]!.details).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '已忽略（沙箱未启用）',
    });
  });

  it('模型审批载荷包含执行模式与豁免结果', async () => {
    process.env.QHY_BYPASS_ENV = 'model-value';
    const { toolResult } = await run({
      calls: [bash('model-review', { command: 'printenv QHY_BYPASS_ENV', disableSandbox: true })],
      sandbox: { enabled: false },
      mode: 'auto',
    });

    expect(toolResult).toMatchObject({ is_error: false, output: { sandboxed: false } });
    expect(fixture!.approvalRequests).toHaveLength(1);
    const payload = JSON.parse(fixture!.approvalRequests[0]!.messages.at(-1)!.content) as {
      toolName: string;
      input: unknown;
      context: { environment: { toolDetails: Record<string, string> } };
    };
    expect(payload).toMatchObject({
      toolName: 'Bash',
      input: { command: 'printenv QHY_BYPASS_ENV', disableSandbox: true },
    });
    expect(payload.context.environment.toolDetails).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '已忽略（沙箱未启用）',
    });
  });
});

describe('general-purpose 子 Agent', () => {
  it('沿用同一沙箱配置并接受 disableSandbox 申请', async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-subagent-')));
    fixture = await startLocalOpenAIModel((_request, index) => {
      if (index === 1) return { calls: [{ id: 'delegate', type: 'function', function: {
        name: 'agent', arguments: JSON.stringify({ description: '运行命令', prompt: '执行子任务' }),
      } }] };
      if (index === 2) return { calls: [bash('subagent-bash', { command: 'printf subagent > subagent.txt', disableSandbox: true })] };
      if (index === 3) return { content: '子 Agent 完成。' };
      return { content: '主 Agent 完成。' };
    });
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000, humanTimeoutMs: 30_000 },
      permissions: { allow: [], ask: [], deny: [], sandbox: { ...DEFAULT_SANDBOX, enabled: false } },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace, timeoutMs: 5000, maxSteps: 6,
    };
    const approvals: ToolApprovalRequest[] = [];

    await runAgent(config, '委派子任务', {
      smokeTool: false,
      approvalControl: async (call) => {
        approvals.push(call);
        return 'approve';
      },
    });

    expect(approvals.map(({ toolName }) => toolName)).toEqual(['Bash']);
    expect(approvals[0]!.input).toMatchObject({ command: 'printf subagent > subagent.txt', disableSandbox: true });
    expect(approvals[0]!.details).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '已忽略（沙箱未启用）',
    });
    expect(await readFile(join(workspace, 'subagent.txt'), 'utf8')).toBe('subagent');
  });
});

// 只有在真实 Seatbelt 可用的 macOS 上才能区分“沙箱内/外执行”；其他平台仅验证不可用路径。
describe.skipIf(process.platform !== 'darwin')('真实 Seatbelt 下的豁免执行', () => {
  async function setupOutside(): Promise<{ outside: string; tempRoot: string }> {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qhy-sandbox-bypass-real-')));
    const outside = join(root, 'outside');
    const tempRoot = join(root, 'tmp');
    await Promise.all([mkdir(outside), mkdir(tempRoot)]);
    // 沙箱计划读取 CLI 进程环境；把 TMPDIR 限制在专用目录，确保 root/outside 不被写白名单覆盖。
    process.env.TMPDIR = tempRoot;
    return { outside, tempRoot };
  }

  it('单段命令精确命中排除表时以完全宿主方式执行，不裁剪环境变量', async () => {
    await setupOutside();
    process.env.QHY_BYPASS_ENV = 'host-inherited';
    const { approvals, toolResult } = await run({
      calls: [bash('exact-hit', { command: 'printenv QHY_BYPASS_ENV', disableSandbox: true })],
      sandbox: { enabled: true, bypassAllowedCommands: ['printenv QHY_BYPASS_ENV'] },
    });

    expect(toolResult).toMatchObject({
      is_error: false,
      output: { stdout: 'host-inherited\n', sandboxed: false, exitCode: 0 },
    });
    expect(toolResult.output).toMatchObject({ notice: expect.stringContaining('豁免获准') });
    expect(approvals[0]!.details).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '获准',
    });
  });

  it('多段命令全部命中（含 :* 前缀）时整条命令以宿主方式执行', async () => {
    const { outside } = await setupOutside();
    const command = `touch ${outside}/exact-hit && touch ${outside}/prefix-hit a`;
    const { approvals, toolResult } = await run({
      calls: [bash('multi-hit', { command, disableSandbox: true })],
      sandbox: { enabled: true, bypassAllowedCommands: [`touch ${outside}/exact-hit`, `touch ${outside}/prefix-hit:*`] },
    });

    expect(toolResult).toMatchObject({ is_error: false, output: { sandboxed: false, exitCode: 0 } });
    await expect(readFile(join(outside, 'exact-hit'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(outside, 'prefix-hit'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(workspace, 'a'), 'utf8')).resolves.toBe('');
    expect(approvals[0]!.details).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '获准',
    });
  });

  it('任一简单命令未命中时仍进沙箱，审批显示豁免未获准', async () => {
    const { outside } = await setupOutside();
    const command = `touch ${outside}/allowed && touch ${outside}/blocked`;
    const { approvals, toolResult } = await run({
      calls: [bash('partial-miss', { command, disableSandbox: true })],
      sandbox: { enabled: true, bypassAllowedCommands: [`touch ${outside}/allowed`] },
    });

    expect(toolResult).toMatchObject({ is_error: true, output: { sandboxed: true } });
    await expect(readFile(join(outside, 'allowed'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'blocked'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(approvals[0]!.details).toMatchObject({
      sandboxExecution: '沙箱内执行',
      sandboxBypass: '未获准',
      sandboxNotice: expect.stringContaining('豁免未获准'),
    });
  });

  it('豁免路径仍完整执行 deny、ask、allow 策略', async () => {
    await setupOutside();
    const { approvals, toolResults } = await run({
      calls: [
        bash('allowed', { command: 'printf allowed-ok', disableSandbox: true }),
        bash('denied', { command: 'touch denied-target', disableSandbox: true }),
        bash('asked', { command: 'printf ask-me', disableSandbox: true }),
      ],
      sandbox: {
        enabled: true,
        bypassAllowedCommands: ['printf allowed-ok', 'touch denied-target', 'printf ask-me'],
      },
      rules: {
        allow: ['Bash(printf allowed-ok)'],
        ask: ['Bash(printf ask-me)'],
        deny: ['Bash(touch denied-target)'],
      },
    });

    expect(toolResults.map(({ is_error }) => is_error)).toEqual([false, true, false]);
    expect(toolResults[0]).toMatchObject({ output: { stdout: 'allowed-ok', sandboxed: false } });
    expect(toolResults[1]).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(toolResults[2]).toMatchObject({ output: { stdout: 'ask-me', sandboxed: false } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.input).toMatchObject({ command: 'printf ask-me', disableSandbox: true });
    expect(approvals[0]!.details).toMatchObject({ sandboxExecution: '沙箱外执行', sandboxBypass: '获准' });
    await expect(readFile(join(workspace, 'denied-target'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('模型审批同样看到获准的沙箱外执行', async () => {
    const { outside } = await setupOutside();
    const command = `touch ${outside}/model-hit`;
    const { toolResult } = await run({
      calls: [bash('model-hit', { command, disableSandbox: true })],
      sandbox: { enabled: true, bypassAllowedCommands: [command] },
      mode: 'auto',
    });

    expect(toolResult).toMatchObject({ is_error: false, output: { sandboxed: false } });
    const payload = JSON.parse(fixture!.approvalRequests[0]!.messages.at(-1)!.content) as {
      context: { environment: { toolDetails: Record<string, string> } };
    };
    expect(payload.context.environment.toolDetails).toMatchObject({
      sandboxExecution: '沙箱外执行',
      sandboxBypass: '获准',
    });
    await expect(readFile(join(outside, 'model-hit'), 'utf8')).resolves.toBe('');
  });
});