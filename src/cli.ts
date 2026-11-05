#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { runAgent } from './agent.js';
import { DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS, isMissing, loadConfig, loggableConfig } from './config.js';
import { loadConversation, newConversationId, saveConversation } from './conversations.js';
import { AgentError, publicError } from './errors.js';
import { CliInput } from './cli-input.js';
import type { ApprovalControl } from './tool-approval.js';

const help = `用法：node dist/cli.js [选项]

启动后直接进入交互式对话，输入 /exit 结束。

选项：
  --workspace <目录>  覆盖配置的工作区（相对当前目录）
  --config <文件>     指定 JSON 配置（默认 agent.config.json）
  --conversation-id <ID>  继续指定会话（省略时新建会话）
  --smoke-tool        强制读取探针文件并验证模型使用结果
  --help              显示帮助

从当前目录 .env 或环境变量读取配置中 apiKeyEnv 指定的凭据。
回答流式输出到 stdout；会话历史保存在当前目录 .agent/conversations/；运行 JSON 日志及错误输出到 stderr。
`;

function log(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

async function main(): Promise<void> {
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new AgentError('CANCELLED', '请求已取消。'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let input: CliInput | undefined;
  try {
    if (process.versions.node.split('.')[0] !== '24') {
      throw new AgentError('CONFIG_ERROR', '请使用项目锁定的 Node.js 24.22.2（见 .nvmrc）。');
    }
    let args: ReturnType<typeof parseCliArgs>;
    try {
      args = parseCliArgs();
    } catch {
      throw new AgentError('CONFIG_ERROR', '命令参数无效，运行 --help 查看用法。');
    }
    if (args.values.help) {
      process.stdout.write(help);
      return;
    }
    if (args.positionals.length > 0) {
      throw new AgentError('CONFIG_ERROR', '交互模式不接受位置参数，请启动后在终端输入需求。');
    }
    if (args.values['smoke-tool'] && args.values['conversation-id'] !== undefined) {
      throw new AgentError('CONFIG_ERROR', '--smoke-tool 不能与 --conversation-id 同时使用。');
    }
    try {
      loadEnvFile();
    } catch (error) {
      if (!isMissing(error)) throw new AgentError('CONFIG_ERROR', '无法读取当前目录 .env 文件。');
    }
    const config = await loadConfig({
      cwd: process.cwd(),
      env: process.env,
      ...(args.values.config === undefined ? {} : { configPath: args.values.config }),
      ...(args.values.workspace === undefined ? {} : { workspace: args.values.workspace }),
    });
    const smokeTool = args.values['smoke-tool'] ?? false;
    const conversationId = args.values['conversation-id'] ?? newConversationId();
    const conversationDirectory = join(process.cwd(), '.agent', 'conversations');
    let history: ModelMessage[] = smokeTool ? [] : await loadConversation(conversationDirectory, conversationId);
    if (smokeTool) {
      await runTurn('smoke', config, history, conversationDirectory, conversationId, cancellation.signal, true);
      return;
    }

    input = new CliInput(cancellation.signal, cancel, config.approval.humanTimeoutMs ?? DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS);
    if (process.stdin.isTTY) input.prompt();
    for await (const line of input) {
      const prompt = line.trim();
      if (prompt === '/exit') break;
      if (!prompt) {
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      try {
        history = await runTurn(prompt, config, history, conversationDirectory, conversationId, cancellation.signal, false, input.approve);
      } catch (error) {
        if (cancellation.signal.aborted) throw error;
        const failure = publicError(error);
        process.stdout.write(`\n错误：${failure.message}\n`);
      }
      if (process.stdin.isTTY) input.prompt();
    }
    cancellation.signal.throwIfAborted();
  } catch (error) {
    const failure = publicError(error);
    log({
      event: 'run.finished', runId: lastRunId, status: 'failed',
      durationMs: Math.round(performance.now() - lastRunStartedAt),
      error: { code: failure.code, message: failure.message },
    });
    process.exitCode = failure.exitCode;
  } finally {
    input?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

let lastRunId = randomUUID();
let lastRunStartedAt = performance.now();

async function runTurn(
  prompt: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  history: ModelMessage[],
  conversationDirectory: string,
  conversationId: string,
  signal: AbortSignal,
  smokeTool: boolean,
  approvalControl?: ApprovalControl,
): Promise<ModelMessage[]> {
  lastRunId = randomUUID();
  lastRunStartedAt = performance.now();
  log({
    event: 'run.started', runId: lastRunId, status: 'running', config: loggableConfig(config), smokeTool,
    ...(smokeTool ? {} : { conversationId }),
  });
  try {
    const result = await runAgent(config, prompt, {
      smokeTool,
      history,
      onText: (chunk) => process.stdout.write(chunk),
      onToolEvent: ({ toolName, status }) => {
        const label = {
          started: '开始',
          succeeded: '成功',
          failed: '失败',
          rejected: '拒绝',
        }[status];
        process.stdout.write(`\n[工具] ${toolName}：${label}\n`);
      },
      signal,
      ...(config.approval.mode === 'human' && approvalControl ? { approvalControl } : {}),
    });
    signal.throwIfAborted();
    const nextHistory = smokeTool ? history : [
      ...history,
      { role: 'user' as const, content: prompt },
      ...result.responseMessages,
    ];
    if (!smokeTool) await saveConversation(conversationDirectory, conversationId, nextHistory);
    process.stdout.write('\n');
    log({
      event: 'run.finished', runId: lastRunId, status: 'succeeded',
      durationMs: Math.round(performance.now() - lastRunStartedAt),
      steps: result.steps, toolCalls: result.toolCalls,
      finishReason: result.finishReason, usage: result.usage,
      toolSmokePassed: result.toolSmokePassed,
      ...(smokeTool ? {} : { conversationId }),
    });
    return nextHistory;
  } catch (error) {
    const failure = publicError(error);
    if (!smokeTool) {
      log({
        event: 'run.finished', runId: lastRunId, status: 'failed',
        durationMs: Math.round(performance.now() - lastRunStartedAt),
        error: { code: failure.code, message: failure.message }, conversationId,
      });
    }
    throw error;
  }
}

function parseCliArgs() {
  return parseArgs({
    options: {
      workspace: { type: 'string' },
      config: { type: 'string' },
      'conversation-id': { type: 'string' },
      'smoke-tool': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
}

await main();
