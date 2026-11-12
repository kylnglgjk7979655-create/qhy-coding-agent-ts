#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { runAgent } from './query/agent.js';
import { abortAllBackgroundAgentTasks, backgroundAgentTasksForSession } from './tools/AgentTool/background-agent-tasks.js';
import { DEFAULT_CONTEXT, DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS, isMissing, loadConfig, loggableConfig, restoreSessionConfig } from './services/settings/config.js';
import { appendRoundMessages, appendRoundText, appendSessionEvent, createSession, finishSessionRound, listSessions, loadLegacyConversation, loadSession, newConversationId, recordFileBackup, reconstructSessionHistory, saveLegacyConversation, sessionTaskOutputDirectory, startSessionRound } from './services/session/conversations.js';
import type { WorkspaceFileSnapshot } from './tools/workspace-files.js';
import { applyFileRewind, fileRewindPlanChanged, formatFileRewindPreview, prepareFileRewind } from './services/session/file-checkpoints.js';
import type { FileRewindPlan } from './services/session/file-checkpoints.js';
import { AgentError, publicError } from './utils/errors.js';
import { CliInput } from './cli/cli-input.js';
import type { ApprovalControl } from './tools/tool-approval.js';
import { acquireSessionLock } from './services/session/session-lock.js';

const help = `用法：node dist/cli.js [选项]

启动后直接进入交互式对话，输入 /exit 结束。
  /new                 在当前工作区新建会话
  /clear               新建会话（等同于 /new）
  /resume [ID]         继续会话；省略 ID 时用方向键选择，/resume all 查看全部
  /rewind              预览并确认恢复到消息级文件检查点

选项：
  --workspace <目录>  覆盖配置的工作区（相对当前目录）
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
  let activeRound: AbortController | undefined;
  let input: CliInput | undefined;
  const cancel = (): void => {
    if (activeRound) activeRound.abort(new AgentError('CANCELLED', 'Interrupt by user'));
    else if (input) input.close();
    else cancellation.abort(new AgentError('CANCELLED', 'Interrupt by user'));
  };
  process.on('SIGINT', cancel);
  const terminate = (): void => cancellation.abort(new AgentError('CANCELLED', '进程收到终止信号。'));
  process.once('SIGTERM', terminate);
  let releaseSession: (() => Promise<void>) | undefined;
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
    const loadCurrentConfig = async () => {
      const loaded = await loadConfig({
        cwd: process.cwd(),
        env: process.env,
        ...(args.values.workspace === undefined ? {} : { workspace: args.values.workspace }),
      });
      return loaded;
    };
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
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, migrationWarnings: _migrationWarnings, ...persistedConfig } = config;
        session = await createSession(userHome, {
          id: conversationId,
          workspace: config.workspace,
          config: persistedConfig,
          ...(legacyHistory === undefined ? {} : { transcript: legacyHistory, effectiveHistory: legacyHistory }),
        });
      }
    } else {
      config = await loadCurrentConfig();
      if (smokeTool) session = undefined;
      else {
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, migrationWarnings: _migrationWarnings, ...persistedConfig } = config;
        session = await createSession(userHome, { id: conversationId, workspace: config.workspace, config: persistedConfig });
      }
    }
    if (session) releaseSession = await acquireSessionLock(userHome, conversationId);
    const legacyDirectory = join(process.cwd(), '.agent', 'conversations');
    let recoveredRoundIds: string[] = [];
    let history: ModelMessage[];
    if (legacyHistory) history = legacyHistory;
    else if (session) {
      const recovered = reconstructSessionHistory(session);
      history = recovered.history;
      recoveredRoundIds = recovered.recoveredRoundIds;
    } else history = [];
    if (smokeTool) {
      activeRound = new AbortController();
      await runTurn('smoke', config, history, userHome, conversationId, AbortSignal.any([cancellation.signal, activeRound.signal]), true);
      return;
    }

    input = new CliInput(cancellation.signal, cancel, config.approval.humanTimeoutMs ?? DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS);
    const fileBaselinesBySession = new Map<string, Map<string, WorkspaceFileSnapshot>>();
    const fileBaselinesForSession = (id: string): Map<string, WorkspaceFileSnapshot> => {
      let baselines = fileBaselinesBySession.get(id);
      if (!baselines) {
        baselines = new Map();
        fileBaselinesBySession.set(id, baselines);
      }
      return baselines;
    };
    let fileBaselines = fileBaselinesForSession(conversationId);
    let unsubscribeNotifications: (() => void) | undefined;
    const bindBackgroundNotifications = (id: string): void => {
      unsubscribeNotifications?.();
      const context = config.context ?? DEFAULT_CONTEXT;
      const tasks = backgroundAgentTasksForSession(id, sessionTaskOutputDirectory(userHome, id), context.capacityTokens - context.answerReserveTokens);
      unsubscribeNotifications = tasks.subscribeNotifications((notification) => input?.enqueueNotification(id, notification));
    };
    bindBackgroundNotifications(conversationId);
    const switchSession = async (id: string) => {
      const resumed = await resumeSession(userHome, id);
      if (id !== conversationId) {
        const nextRelease = await acquireSessionLock(userHome, id);
        await releaseSession?.();
        releaseSession = nextRelease;
        fileBaselines = fileBaselinesForSession(id);
      }
      config = resumed.config;
      conversationId = id;
      bindBackgroundNotifications(id);
      process.stdout.write(`已继续会话：${id}（工作区：${resumed.config.workspace}）\n`);
      return resumed;
    };
    let rewindSelection: { plan: FileRewindPlan } | undefined;
    if (process.stdin.isTTY) input.prompt();
    while (true) {
      const workItem = await input.nextWorkItem(conversationId);
      if (!workItem) break;
      if (workItem.type === 'notification') {
        const { notification } = workItem;
        if (!backgroundAgentTasksForSession(conversationId).acknowledgeNotification(notification.taskId)) continue;
        process.stdout.write(`\n[后台任务通知] ${notification.summary}：${notification.status}\n`);
        const notificationPrompt = [
          '后台子 Agent 已完成，请处理以下属于当前会话的通知，并向用户简要汇报结果。',
          JSON.stringify(notification),
        ].join('\n');
        try {
          activeRound = new AbortController();
          history = await runTurn(notificationPrompt, config, history, userHome, conversationId, AbortSignal.any([cancellation.signal, activeRound.signal]), false, input.approve, legacyDirectory, recoveredRoundIds, fileBaselines);
          const recovered = reconstructSessionHistory(await loadSession(userHome, conversationId));
          history = recovered.history;
          recoveredRoundIds = recovered.recoveredRoundIds;
        } catch (error) {
          if (cancellation.signal.aborted) throw error;
          process.stdout.write(`\n错误：${publicError(error).message}\n`);
        } finally {
          activeRound = undefined;
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      const prompt = workItem.text.trim();
      if (rewindSelection) {
        if (prompt === '/exit') {
          rewindSelection = undefined;
          break;
        }
        if (prompt === '/cancel' || prompt.toLowerCase() === 'no' || prompt.toLowerCase() === 'n') {
          rewindSelection = undefined;
          process.stdout.write('已取消文件检查点恢复，文件保持不变。\n');
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        if (prompt.toLowerCase() !== 'yes' && prompt.toLowerCase() !== 'y') {
          process.stdout.write('请输入 yes 确认，或 no /cancel 取消。\n');
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        try {
          const refreshed = await prepareFileRewind(await loadSession(userHome, conversationId), rewindSelection.plan.checkpoint.id);
          if (fileRewindPlanChanged(rewindSelection.plan, refreshed)) {
            rewindSelection.plan = refreshed;
            process.stdout.write(`文件状态已变化，预览已刷新。\n${formatFileRewindPreview(refreshed)}\n请再次确认恢复请输入 yes，输入 no 或 /cancel 取消：\n`);
            if (process.stdin.isTTY) input.prompt();
            continue;
          }
          const results = await applyFileRewind(refreshed);
          const targetSummary = refreshed.items.map(({ path, target }) => `- ${path}：${target.existed ? '检查点中存在' : '检查点中不存在'}`).join('\n') || '- 检查点不包含已追踪文件';
          const resultSummary = results.map(({ path, status, message }) => `- ${path}：${status === 'succeeded' ? '成功' : '失败'}（${message}）`).join('\n') || '- 无文件需要处理';
          const eventMessages: ModelMessage[] = [
            { role: 'user', content: `恢复文件检查点请求：目标消息 ${refreshed.checkpoint.messageId}，检查点 ${refreshed.checkpoint.id}。目标文件状态：\n${targetSummary}` },
            { role: 'assistant', content: `恢复文件检查点结果：\n${resultSummary}` },
          ];
          process.stdout.write(`恢复结果：\n${resultSummary}\n`);
          await appendSessionEvent(userHome, conversationId, eventMessages);
          history = [...history, ...eventMessages];
          rewindSelection = undefined;
        } catch (error) {
          process.stdout.write(`文件检查点恢复失败：${error instanceof Error ? error.message : '无法保存恢复结果。'}\n`);
          rewindSelection = undefined;
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/exit') break;
      if (prompt === '/new' || prompt === '/clear') {
        const id = newConversationId();
        const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, ...persistedConfig } = config;
        await createSession(userHome, { id, workspace: config.workspace, config: persistedConfig });
        const nextRelease = await acquireSessionLock(userHome, id);
        await releaseSession?.();
        releaseSession = nextRelease;
        conversationId = id;
        history = [];
        fileBaselines = fileBaselinesForSession(conversationId);
        recoveredRoundIds = [];
        bindBackgroundNotifications(id);
        process.stdout.write(`已新建会话：${id}\n`);
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/rewind') {
        const currentSession = await loadSession(userHome, conversationId);
        const checkpoints = [...currentSession.checkpoints].reverse();
        if (checkpoints.length === 0) process.stdout.write('当前会话没有可用的消息检查点。\n');
        else {
          const choices = checkpoints.map((checkpoint) => {
            const round = currentSession.rounds.find(({ id }) => id === checkpoint.messageId);
            const transcriptMessage = round?.transcriptStart === undefined
              ? undefined : currentSession.transcript[round.transcriptStart];
            const message = transcriptMessage?.role === 'user' ? userMessageText(transcriptMessage) : '';
            return {
              label: transcriptMessage?.role === 'user'
                ? message || '（无文本用户消息）'
                : `原始用户消息不可用（检查点 ${checkpoint.id}）`,
              detail: `${checkpoint.createdAt} · 检查点 ${checkpoint.id}${checkpoint.files ? ` · ${checkpoint.files.length} 个文件` : ' · 文件清单缺失'}`,
              value: checkpoint.id,
            };
          });
          const checkpointId = await input.select('选择要预览的用户消息恢复点', choices);
          if (checkpointId) {
            try {
              const plan = await prepareFileRewind(await loadSession(userHome, conversationId), checkpointId);
              rewindSelection = { plan };
              process.stdout.write(`${formatFileRewindPreview(plan)}\n确认恢复请输入 yes，输入 no 或 /cancel 取消：\n`);
            } catch (error) {
              process.stdout.write(`无法开始恢复：${error instanceof Error ? error.message : '检查点无效。'}\n`);
            }
          } else process.stdout.write('已取消文件检查点选择，文件保持不变。\n');
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/resume' || prompt === '/resume all') {
        const all = prompt.endsWith(' all');
        const sessions = await listSessions(userHome, all ? undefined : config.workspace);
        const choices: Array<{ label: string; detail: string; value: { kind: 'session'; id: string } | { kind: 'all' } }> = sessions.map((session) => ({
          label: session.title || '未命名会话',
          detail: `${session.updatedAt} · ${session.workspace} · ${session.id}`,
          value: { kind: 'session' as const, id: session.id },
        }));
        if (!all) choices.push({ label: '查看全部会话', detail: '包括其他工作区的会话', value: { kind: 'all' as const } });
        if (choices.length === 0) process.stdout.write('没有可用会话。\n');
        else {
          const id = await input.select(all ? '全部会话' : '当前工作区会话', choices);
          if (id?.kind === 'all') {
            const allSessions = await listSessions(userHome);
            if (allSessions.length === 0) {
              process.stdout.write('没有可用会话。\n');
              if (process.stdin.isTTY) input.prompt();
              continue;
            }
            const allChoices = allSessions.map((session) => ({
              label: session.title || '未命名会话',
              detail: `${session.updatedAt} · ${session.workspace} · ${session.id}`,
              value: session.id,
            }));
            const selectedId = await input.select('全部工作区会话', allChoices);
            if (selectedId) {
              try { ({ config, conversationId, history, recoveredRoundIds } = await switchSession(selectedId)); }
              catch (error) { process.stdout.write(`\n错误：${publicError(error).message}\n`); }
            }
          } else if (id?.kind === 'session') {
            try { ({ config, conversationId, history, recoveredRoundIds } = await switchSession(id.id)); }
            catch (error) { process.stdout.write(`\n错误：${publicError(error).message}\n`); }
          }
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt.startsWith('/resume ')) {
        const id = prompt.slice('/resume '.length).trim();
        try {
          ({ config, conversationId, history, recoveredRoundIds } = await switchSession(id));
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
        activeRound = new AbortController();
        const turnSignal = AbortSignal.any([cancellation.signal, activeRound.signal]);
        history = await runTurn(prompt, config, history, userHome, conversationId, turnSignal, false, input.approve, legacyDirectory, recoveredRoundIds, fileBaselines);
        const recovered = reconstructSessionHistory(await loadSession(userHome, conversationId));
        history = recovered.history;
        recoveredRoundIds = recovered.recoveredRoundIds;
      } catch (error) {
        if (cancellation.signal.aborted) throw error;
        const failure = publicError(error);
        process.stdout.write(`\n错误：${failure.message}\n`);
      } finally {
        activeRound = undefined;
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
    abortAllBackgroundAgentTasks();
    input?.close();
    await releaseSession?.().catch(() => undefined);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', terminate);
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
  fileBaselines: Map<string, WorkspaceFileSnapshot> = new Map(),
): Promise<ModelMessage[]> {
  let roundId: string | undefined;
  let summaryCoverageBase = 0;
  let bashFailed = false;
  lastRunId = randomUUID();
  lastRunStartedAt = performance.now();
  log({
    event: 'run.started', runId: lastRunId, status: 'running', config: loggableConfig(config), smokeTool,
    ...(smokeTool ? {} : { conversationId }),
  });
  try {
    if (!smokeTool) {
      const { apiKey: _apiKey, approvalApiKey: _approvalApiKey, mcpHeaders: _mcpHeaders, migrationWarnings: _migrationWarnings, ...persistedConfig } = config;
      roundId = await startSessionRound(userHome, conversationId, prompt, persistedConfig, () => {
        log({ event: 'checkpoint.snapshot_failed', conversationId, message: '消息检查点文件快照失败，继续处理。' });
      });
      summaryCoverageBase = (await loadSession(userHome, conversationId)).summaries.at(-1)?.coversThrough ?? 0;
    }
    const result = await runAgent(config, prompt, {
      smokeTool,
      history,
      summaryCoverageBase,
      fileBaselines,
      ...(!smokeTool ? { backgroundTasks: backgroundAgentTasksForSession(
        conversationId,
        sessionTaskOutputDirectory(userHome, conversationId),
        (config.context ?? DEFAULT_CONTEXT).capacityTokens - (config.context ?? DEFAULT_CONTEXT).answerReserveTokens,
      ) } : {}),
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
      onBeforeWrite: async (snapshot: WorkspaceFileSnapshot) => {
        if (!roundId) return;
        await recordFileBackup(userHome, conversationId, roundId, snapshot);
      },
      onCheckpointError: () => {
        log({ event: 'checkpoint.backup_failed', conversationId, message: 'write_file 原状态备份失败，继续写入。' });
      },
      onToolEvent: ({ toolName, description, status }) => {
        if (toolName === 'Bash' && status === 'failed') bashFailed = true;
        const label = {
          started: '开始',
          succeeded: '成功',
          failed: '失败',
          rejected: '拒绝',
        }[status];
        const shortDescription = description
          ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        if (toolName === 'agent' && shortDescription) {
          process.stdout.write(`\n[Explore] ${shortDescription}：${label}\n`);
          return;
        }
        process.stdout.write(`\n[工具] ${toolName}：${label}\n`);
      },
      signal,
      ...(config.approval.mode === 'default' && approvalControl ? { approvalControl } : {}),
    });
    signal.throwIfAborted();
    const nextHistory = smokeTool ? history : result.effectiveHistory;
    if (!smokeTool) {
      if (!roundId) throw new AgentError('PROVIDER_ERROR', '当前轮次未能建立持久化记录。');
      await finishSessionRound(userHome, conversationId, roundId, {
        status: 'succeeded', response: result.responseMessages, effectiveHistory: nextHistory,
        summaries: result.summaries, recoveredRoundIds,
      });
      if (legacyDirectory) await saveLegacyConversation(legacyDirectory, conversationId, nextHistory).catch(() => undefined);
    }
    if (bashFailed) process.stdout.write('\n注意：本轮 Bash 命令执行失败，回复未获命令验证。\n');
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
    const interrupted = failure.code === 'CANCELLED' && failure.message === 'Interrupt by user';
    if (interrupted && !smokeTool && roundId) {
      await finishSessionRound(userHome, conversationId, roundId, {
        status: 'cancelled', error: { code: 'CANCELLED', message: 'Interrupt by user' },
      }).catch(() => undefined);
      process.stdout.write('\n用户中断：Interrupt by user\n');
      log({ event: 'run.finished', runId: lastRunId, status: 'cancelled', durationMs: Math.round(performance.now() - lastRunStartedAt), conversationId });
      return history;
    }
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
  return { config, conversationId: id, ...recovered };
}

function userMessageText(message: ModelMessage): string {
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
      : '';
  return text.trim();
}
