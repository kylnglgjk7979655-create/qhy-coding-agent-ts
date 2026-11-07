#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { runAgent } from './agent.js';
import { DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS, isMissing, loadConfig, loggableConfig, restoreSessionConfig } from './config.js';
import { appendRoundMessages, appendRoundText, createSession, finishSessionRound, listSessions, loadLegacyConversation, loadSession, newConversationId, reconstructSessionHistory, saveLegacyConversation, startSessionRound } from './conversations.js';
import { AgentError, publicError } from './errors.js';
import { CliInput } from './cli-input.js';
import type { ApprovalControl } from './tool-approval.js';

const help = `用法：node dist/cli.js [选项]

启动后直接进入交互式对话，输入 /exit 结束。
  /new                 在当前工作区新建会话
  /resume [ID]         继续会话；省略 ID 时选择会话，输入 all 查看全部

选项：
  --workspace <目录>  覆盖配置的工作区（相对当前目录）
  --config <文件>     指定 JSON 配置（默认 agent.config.json）
  --conversation-id <ID>  继续指定会话（省略时新建会话）
  --smoke-tool        强制读取探针文件并验证模型使用结果
  --help              显示帮助

从当前目录 .env 或环境变量读取配置中 apiKeyEnv 指定的凭据。
回答流式输出到 stdout；会话记录保存在用户目录 ~/.qhy-coding-agents/；运行 JSON 日志及错误输出到 stderr。
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
    const smokeTool = args.values['smoke-tool'] ?? false;
    let conversationId = args.values['conversation-id'] ?? newConversationId();
    const userHome = homedir();
    const loadCurrentConfig = () => loadConfig({
      cwd: process.cwd(),
      env: process.env,
      ...(args.values.config === undefined ? {} : { configPath: args.values.config }),
      ...(args.values.workspace === undefined ? {} : { workspace: args.values.workspace }),
    });
    let config: Awaited<ReturnType<typeof loadConfig>>;
    let session: Awaited<ReturnType<typeof loadSession>> | undefined;
    let legacyHistory: ModelMessage[] | undefined;
    if (!smokeTool && args.values['conversation-id'] !== undefined) {
      try {
        session = await loadSession(userHome, conversationId);
        config = await restoreSessionConfig(session.config, process.env);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('会话记录不存在：')) throw error;
        config = await loadCurrentConfig();
        const legacyDirectory = join(process.cwd(), '.agent', 'conversations');
        legacyHistory = await loadLegacyConversation(legacyDirectory, conversationId);
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, ...persistedConfig } = config;
        session = await createSession(userHome, { id: conversationId, workspace: config.workspace, config: persistedConfig });
      }
    } else {
      config = await loadCurrentConfig();
      if (smokeTool) session = undefined;
      else {
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, ...persistedConfig } = config;
        session = await createSession(userHome, { id: conversationId, workspace: config.workspace, config: persistedConfig });
      }
    }
    const legacyDirectory = join(process.cwd(), '.agent', 'conversations');
    // Read older workspace histories during migration; the user-level session remains the durable record.
    legacyHistory ??= smokeTool || args.values['conversation-id'] === undefined
      ? undefined : await loadLegacyConversation(legacyDirectory, conversationId);
    let recoveredRoundIds: string[] = [];
    let history: ModelMessage[];
    if (legacyHistory) history = legacyHistory;
    else if (session) {
      const recovered = reconstructSessionHistory(session);
      history = recovered.history;
      recoveredRoundIds = recovered.recoveredRoundIds;
    } else history = [];
    if (smokeTool) {
      await runTurn('smoke', config, history, userHome, conversationId, cancellation.signal, true);
      return;
    }

    input = new CliInput(cancellation.signal, cancel, config.approval.humanTimeoutMs ?? DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS);
    let selection: { sessions: Awaited<ReturnType<typeof listSessions>>; all: boolean } | undefined;
    if (process.stdin.isTTY) input.prompt();
    for await (const line of input) {
      const prompt = line.trim();
      if (prompt === '/exit') break;
      if (selection) {
        if (prompt.toLowerCase() === 'all' && !selection.all) {
          selection = { sessions: await listSessions(userHome), all: true };
          printSessionChoices(selection.sessions, true);
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        const chosen = /^\d+$/.test(prompt) ? selection.sessions[Number(prompt) - 1] : selection.sessions.find(({ id }) => id === prompt);
        if (!chosen) {
          if (prompt === '/cancel') selection = undefined;
          else process.stdout.write('无效的会话选择；请输入列表编号或会话 ID，输入 /cancel 取消。\n');
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        try {
          ({ config, conversationId, history, recoveredRoundIds } = await resumeSession(userHome, chosen.id));
          selection = undefined;
        } catch (error) {
          process.stdout.write(`\n错误：${publicError(error).message}\n`);
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/new') {
        const id = newConversationId();
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, ...persistedConfig } = config;
        await createSession(userHome, { id, workspace: config.workspace, config: persistedConfig });
        conversationId = id;
        history = [];
        recoveredRoundIds = [];
        process.stdout.write(`已新建会话：${id}\n`);
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/resume' || prompt === '/resume all') {
        const all = prompt.endsWith(' all');
        selection = { sessions: await listSessions(userHome, all ? undefined : config.workspace), all };
        printSessionChoices(selection.sessions, all);
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt.startsWith('/resume ')) {
        const id = prompt.slice('/resume '.length).trim();
        try {
          ({ config, conversationId, history, recoveredRoundIds } = await resumeSession(userHome, id));
        } catch (error) {
          process.stdout.write(`\n错误：${publicError(error).message}\n`);
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (!prompt) {
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      try {
        history = await runTurn(prompt, config, history, userHome, conversationId, cancellation.signal, false, input.approve, legacyDirectory, recoveredRoundIds);
        recoveredRoundIds = [];
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
  userHome: string,
  conversationId: string,
  signal: AbortSignal,
  smokeTool: boolean,
  approvalControl?: ApprovalControl,
  legacyDirectory?: string,
  recoveredRoundIds: string[] = [],
): Promise<ModelMessage[]> {
  let roundId: string | undefined;
  lastRunId = randomUUID();
  lastRunStartedAt = performance.now();
  log({
    event: 'run.started', runId: lastRunId, status: 'running', config: loggableConfig(config), smokeTool,
    ...(smokeTool ? {} : { conversationId }),
  });
  try {
    if (!smokeTool) {
      const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, ...persistedConfig } = config;
      roundId = await startSessionRound(userHome, conversationId, prompt, persistedConfig);
    }
    const result = await runAgent(config, prompt, {
      smokeTool,
      history,
      onText: async (chunk) => {
        if (!smokeTool && roundId) await appendRoundText(userHome, conversationId, roundId, chunk);
        process.stdout.write(chunk);
      },
      onToolCallStart: async ({ callId, toolName, input }) => {
        if (!smokeTool && roundId) {
          await appendRoundMessages(userHome, conversationId, roundId, [{
            role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName, input }],
          } as unknown as ModelMessage]);
        }
      },
      onStepMessages: async (content) => {
        if (smokeTool || !roundId) return;
        const results = content.filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null && (part as { type?: string }).type === 'tool-result');
        if (results.length > 0) await appendRoundMessages(userHome, conversationId, roundId, [{ role: 'tool', content: results } as unknown as ModelMessage]);
      },
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
    const nextHistory = smokeTool ? history : result.effectiveHistory;
    if (!smokeTool) {
      if (!roundId) throw new AgentError('PROVIDER_ERROR', '当前轮次未能建立持久化记录。');
      await finishSessionRound(userHome, conversationId, roundId, {
        status: 'succeeded', response: result.responseMessages, effectiveHistory: nextHistory, recoveredRoundIds,
      });
      if (legacyDirectory) await saveLegacyConversation(legacyDirectory, conversationId, nextHistory).catch(() => undefined);
    }
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
    if (!smokeTool && roundId) {
      await finishSessionRound(userHome, conversationId, roundId, {
        status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: { code: failure.code, message: failure.message },
      }).catch(() => undefined);
    }
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

async function resumeSession(userHome: string, id: string): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  conversationId: string;
  history: ModelMessage[];
  recoveredRoundIds: string[];
}> {
  const session = await loadSession(userHome, id);
  const config = await restoreSessionConfig(session.config, process.env);
  const recovered = reconstructSessionHistory(session);
  process.stdout.write(`已继续会话：${id}（工作区：${config.workspace}）\n`);
  return { config, conversationId: id, ...recovered };
}

function printSessionChoices(sessions: Awaited<ReturnType<typeof listSessions>>, all: boolean): void {
  if (sessions.length === 0) process.stdout.write('没有可用会话。\n');
  else {
    process.stdout.write(`${all ? '全部会话' : '当前工作区会话'}：\n`);
    sessions.forEach((session, index) => {
      process.stdout.write(`${index + 1}. ${session.id}  ${session.updatedAt}${all ? `  ${session.workspace}` : ''}\n`);
    });
  }
  process.stdout.write(all ? '输入编号或会话 ID 选择，输入 /cancel 取消。\n' : '输入编号或会话 ID 选择，输入 all 查看全部会话，输入 /cancel 取消。\n');
}
