import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import { DEFAULT_SANDBOX } from '../src/services/settings/config.js';
import type { ResolvedConfig, SandboxConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest } from './helpers/local-openai-fixture.js';
import { tempDir } from './helpers/temp-dir.js';

let workspace = '';
let fixture: Awaited<ReturnType<typeof startLocalOpenAIModel>> | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = '';
});

function systemText(request: FixtureRequest): string {
  return request.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
}

/** 经 runAgent 的公开请求读取模型实际可见的系统提示、Bash 描述与审查提示。 */
async function inspectGuidance(sandbox: Partial<SandboxConfig>): Promise<{
  system: string;
  description: string;
  reviewSystem: string;
}> {
  workspace = await tempDir('qhy-sandbox-guidance-');
  fixture = await startLocalOpenAIModel(
    (_request, index) => index === 1
      ? { calls: [{ id: 'sandbox-guidance', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf guidance' }) } }] }
      : { content: '说明检查完成。' },
    () => ({ content: 'deny' }),
  );
  const config: ResolvedConfig = {
    approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
    permissions: {
      allow: [], ask: [], deny: [],
      sandbox: { ...DEFAULT_SANDBOX, ...sandbox },
    },
    provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
    baseURL: fixture.baseURL, workspace, timeoutMs: 3000, maxSteps: 5,
  };

  await runAgent(config, '检查沙箱说明', { smokeTool: false });

  const firstRequest = fixture.requests[0]!;
  const bashTool = firstRequest.tools.find((tool) => tool.function.name === 'Bash');
  const reviewRequest = fixture.approvalRequests[0];
  expect(bashTool?.function.description).toBeTruthy();
  expect(reviewRequest).toBeDefined();
  return {
    system: systemText(firstRequest),
    description: bashTool!.function.description!,
    reviewSystem: systemText(reviewRequest!),
  };
}

describe('沙箱模型可见说明', () => {
  it('启用时工具描述与系统提示说明开关、读写边界、代理与豁免申请', async () => {
    const { system, description } = await inspectGuidance({
      enabled: true,
      readDenyPaths: ['~/private'],
      readAllowPaths: ['~/private/readable'],
      writePaths: ['~/scratch'],
      writeDenyPaths: ['~/scratch/protected'],
      networkAllow: ['registry.npmjs.org'],
      networkPorts: [443],
      bypassAllowedCommands: ['npm install:*'],
    });

    for (const text of [system, description]) {
      expect(text).toContain('permissions.sandbox.enabled=true');
      expect(text).toContain('readDenyPaths');
      expect(text).toContain('readAllowPaths');
      expect(text).toContain('writePaths');
      expect(text).toContain('writeDenyPaths');
      expect(text).toContain('networkAllow');
      expect(text).toContain('networkPorts');
      expect(text).toContain('本机 HTTP 代理');
      expect(text).toContain('disableSandbox: true');
      expect(text).toContain('bypassAllowedCommands');
      expect(text).toContain('sandboxed');
      expect(text).toContain('notice');
      expect(text).not.toContain('不提供操作系统隔离');
      expect(text).not.toContain('不提供文件系统或网络隔离');
      expect(text).not.toContain('当前未启用沙箱');
    }
  });

  it('networkAllow 为空时说明沙箱没有可用网络', async () => {
    const { system, description } = await inspectGuidance({ enabled: true, networkAllow: [] });

    for (const text of [system, description]) {
      expect(text).toContain('networkAllow 为空');
      expect(text).toContain('没有网络');
      expect(text).not.toContain('可经本机 HTTP 代理访问');
    }
  });

  it('关闭时明确说明无操作系统隔离且 disableSandbox 被忽略', async () => {
    const { system, description } = await inspectGuidance({ enabled: false });

    for (const text of [system, description]) {
      expect(text).toContain('当前未启用沙箱');
      expect(text).toContain('permissions.sandbox.enabled=false');
      expect(text).toContain('没有操作系统隔离');
      expect(text).toContain('disableSandbox 会被忽略');
      expect(text).not.toContain('默认在操作系统沙箱中执行');
      // 旧措辞把“无隔离”当作 Bash 的固定属性，关闭态应只描述当前配置。
      expect(text).not.toContain('不提供操作系统隔离');
      expect(text).not.toContain('不提供文件系统或网络隔离');
    }
  });

  it.each([
    ['open', '未隔离'],
    ['closed', '拒绝执行'],
  ] as const)('按 onUnavailable=%s 说明沙箱不可用时的失败语义', async (mode, expected) => {
    const { system, description } = await inspectGuidance({ enabled: true, onUnavailable: mode });

    for (const text of [system, description]) {
      expect(text).toContain(`onUnavailable="${mode}"`);
      expect(text).toContain(expected);
    }
  });

  it('模型审批提示要求依据执行模式与隔离状态判断，而非假定默认状态', async () => {
    const { reviewSystem } = await inspectGuidance({ enabled: false });

    expect(reviewSystem).toContain('执行模式');
    expect(reviewSystem).toContain('隔离状态');
    expect(reviewSystem).toContain('sandboxExecution');
    expect(reviewSystem).toContain('不要假定');
  });
});