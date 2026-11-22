#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelMessage } from 'ai';
import { estimateContextUsage, runAgent } from './query/agent.js';
import type { ContextUsageEstimate } from './query/agent.js';
import { abortAllBackgroundAgentTasks, backgroundAgentTasksForSession, type BackgroundTaskStatusEntry } from './tools/AgentTool/background-agent-tasks.js';
import { DEFAULT_CONTEXT, DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS, isMissing, loadConfig, loggableConfig, persistableSessionConfig, restoreSessionConfig } from './services/settings/config.js';
import type { ApprovalMode } from './services/settings/config.js';
import { approvalModeLabel, createApprovalModeState, parseApprovalModeCommand } from './tools/approval-mode.js';
import { appendRoundMessages, appendRoundText, appendSessionEvent, createSession, finishSessionRound, listSessions, loadLegacyConversation, loadSession, newConversationId, openSession, recordFileBackup, reconstructSessionHistory, saveCompactionCheckpoint, saveLegacyConversation, saveManualCompaction, sessionRecordPath, sessionTaskOutputDirectory, startSessionRound, type SessionLoadWarning, type SessionRecord } from './services/session/conversations.js';
import type { WorkspaceFileSnapshot } from './tools/workspace-files.js';
import { applyFileRewind, fileRewindPlanChanged, formatFileRewindPreview, prepareFileRewind } from './services/session/file-checkpoints.js';
import type { FileRewindPlan } from './services/session/file-checkpoints.js';
import { AgentError, publicError } from './utils/errors.js';
import { CliInput } from './cli/cli-input.js';
import { formatBeijingTime } from './cli/terminal-text.js';
import { CommandRegistry } from './cli/commands.js';
import { ToolActivityRenderer } from './cli/tool-activity.js';
import { loadSkillCatalogue } from './services/skills/skill-registry.js';
import type { SkillCatalogue } from './services/skills/skill-registry.js';
import { appendRecentSkillLoads } from './services/skills/skill-injection.js';
import type { ApprovalControl } from './tools/tool-approval.js';
import { acquireSessionLock } from './services/session/session-lock.js';
import { generateSummary } from './services/compact/context-summary.js';
import { RecentFileTracker } from './services/compact/recent-files.js';
import { formatHookCommandList, hasHookCommands, isHooksConfigTrusted, trustHooksConfig } from './services/hooks/hook-trust.js';
import type { HooksConfig, SessionStartSource } from './services/hooks/hooks-config.js';
import {
  HookInjectionTracker, describeHookRun, hookInputBase, hookLogFields, runHookEvent,
  sessionStartContextMessages, stopContinuation, stopFeedbackMessages, userPromptSubmitContextMessages,
  userPromptSubmitStop,
} from './services/hooks/hook-engine.js';
import type { HookEventNotification, UserPromptSubmitStop } from './services/hooks/hook-engine.js';
import type { SessionStartHookInput, StopHookInput, UserPromptSubmitHookInput } from './services/hooks/hook-runner.js';
import type { LoadedConfig } from './services/settings/config.js';
import { createLangfuseTracer } from './services/observability/langfuse.js';
import type { LangfuseTracer, TraceHandle } from './services/observability/langfuse.js';
import { AgentObservations } from './services/observability/agent-observations.js';

const help = `用法：node dist/cli.js [选项]

启动后直接进入交互式对话，输入 /exit 结束。
  /new                 在当前工作区新建会话；交互终端下清屏
  /clear               新建会话（等同于 /new）
  /resume [ID]         继续会话；省略 ID 时用方向键选择，/resume all 查看全部
  /rewind              预览并确认恢复到消息级文件检查点
  /compact             压缩当前有效历史并保存；空闲时立即生效，执行中在当前工具完成后生效
  /context             显示当前有效历史的估算输入用量、配置容量与使用比例
  /permission-mode [模式]  查看或切换当前进程的审批模式（default / auto / plan）
  交互终端按 Shift+Tab 在 default → auto → plan → default 间循环切换模式

选项：
  --workspace <目录>  覆盖配置的工作区（相对当前目录）
  --conversation-id <ID>  继续指定会话（省略时新建会话）
  --permission-mode <模式>  本次进程使用 default（人工审批）、auto（模型审批）或 plan（只读）
  --smoke-tool        强制读取探针文件并验证模型使用结果
  --trust-hooks       跳过 Hook 信任确认并记录当前 Hook 配置
  --no-hooks          本次运行禁用全部 Hook
  --help              显示帮助

从当前目录 .env 或环境变量读取配置中 apiKeyEnv 指定的凭据。
回答流式输出到 stdout；会话记录保存在用户目录 ~/.qhy-coding-agents/；交互模式隐藏运行 JSON 日志并显示可读错误。
`;

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function log(event: Record<string, unknown>): void {
  if (isInteractiveTerminal()) return;
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

/** 调试开关独立于普通日志；开启后才允许把 Hook 输出正文写入结构化日志。 */
function hookDebugEnabled(): boolean {
  return process.env.QHY_HOOK_DEBUG?.trim() === '1';
}

/**
 * Hook 观测回调：结构化日志只含元数据，回调异常不会传播到 Hook 执行或模型流程。
 * 完整 stdout/stderr 仅在显式调试开关下追加；suppressOutput 仍隐藏普通 stdout。
 */
function reportHookEvent(notification: HookEventNotification): void {
  if (notification.phase === 'started') {
    log({ event: 'hook.started', hookEvent: notification.event, hook: notification.hookId });
    return;
  }
  const run = notification.run;
  if (run === undefined) return;
  log({
    event: notification.phase === 'failed' ? 'hook.failed' : 'hook.finished',
    ...hookLogFields(run),
    ...(hookDebugEnabled() && run.result.suppressOutput !== true
      ? { stdout: run.result.stdout, stderr: run.result.stderr }
      : {}),
  });
}

function formatUserError(error: unknown): string {
  const failure = publicError(error);
  const code = isInteractiveTerminal() ? `（${failure.code}）` : '';
  return `错误${code}：${failure.message}`;
}

/** `/resume` 当前工作区与全部工作区两个列表共用同一明细格式：北京时间、工作区与会话 ID。 */
function sessionChoiceDetail(session: Pick<SessionRecord, 'updatedAt' | 'workspace' | 'id'>): string {
  return `${formatBeijingTime(session.updatedAt)} · ${session.workspace} · ${session.id}`;
}

// 用量按发送前估算展示，不声称与服务端精确 token 计数一致；MCP 定义需连接远端才能发现，不计入。
function formatContextUsage(usage: ContextUsageEstimate, config: Awaited<ReturnType<typeof loadConfig>>): string {
  const tokens = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const lines = [
    `上下文用量（估算）：约 ${tokens(usage.estimatedInputTokens)} / ${tokens(usage.capacityTokens)} tokens（${(usage.usageRatio * 100).toFixed(1)}%）`,
    '估算包含系统提示、可用工具定义与当前有效历史，不等同于服务端精确 token 计数；命令不发起模型请求或修改历史。',
  ];
  if ((config.mcp?.servers.length ?? 0) > 0) lines.push('未连接远程 MCP 服务，配置的 MCP 工具定义未计入估算。');
  return `${lines.join('\n')}\n`;
}

function reportCheckpointWarning(event: string, message: string, details: Record<string, unknown>): void {
  if (isInteractiveTerminal()) process.stdout.write(`\n警告：${message}\n`);
  else log({ event, ...details, message });
}

/** 会话记录尾部不完整或快照无效时提示用户；恢复本身继续进行。 */
function reportSessionWarning(conversationId: string, warning: SessionLoadWarning): void {
  reportCheckpointWarning(`session.${warning.code}`, warning.message, { conversationId });
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
    const permissionMode = args.values['permission-mode'];
    if (permissionMode !== undefined && permissionMode !== 'default' && permissionMode !== 'auto' && permissionMode !== 'plan') {
      throw new AgentError('CONFIG_ERROR', '--permission-mode 只接受 default、auto 或 plan。运行 --help 查看用法。');
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
    const noHooks = args.values['no-hooks'] ?? false;
    const trustHooksOptIn = (args.values['trust-hooks'] ?? false)
      || process.env.QHY_TRUST_HOOKS?.trim() === '1';
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
    const disableHookConfig = (loaded: LoadedConfig): LoadedConfig => {
      const { hooks: _hooks, ...rest } = loaded;
      return rest;
    };
    const persistHookTrust = async (workspace: string, hooks: HooksConfig): Promise<void> => {
      try {
        await trustHooksConfig(userHome, workspace, hooks);
      } catch {
        // 记录失败不应阻断已获授权的本次运行；下次启动会重新要求确认。
        process.stderr.write('警告：无法保存 Hook 信任记录；本次运行仍启用已确认的 Hook。\n');
      }
    };
    /**
     * 信任门禁：禁用开关优先，未信任的非交互运行 fail-closed。
     * 只有交互终端会在任何 Hook 执行前展示完整命令清单并等待确认。
     */
    const applyHookTrust = async (loaded: LoadedConfig): Promise<LoadedConfig> => {
      if (noHooks || loaded.disableAllHooks) return disableHookConfig(loaded);
      const hooks = loaded.hooks;
      if (!hasHookCommands(hooks)) return loaded;
      if (await isHooksConfigTrusted(userHome, loaded.workspace, hooks)) return loaded;
      if (trustHooksOptIn) {
        await persistHookTrust(loaded.workspace, hooks);
        return loaded;
      }
      if (!input || !process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('警告：检测到未信任的 Hook 配置，已禁用全部 Hook；使用 --trust-hooks 或 QHY_TRUST_HOOKS=1 显式信任。\n');
        return disableHookConfig(loaded);
      }
      const accepted = await input.confirmHookTrust(loaded.workspace, formatHookCommandList(hooks));
      if (!accepted) {
        process.stdout.write('已禁用全部 Hook。\n');
        return disableHookConfig(loaded);
      }
      await persistHookTrust(loaded.workspace, hooks);
      return loaded;
    };
    let config: Awaited<ReturnType<typeof loadConfig>>;
    let session: Awaited<ReturnType<typeof loadSession>> | undefined;
    let legacyHistory: ModelMessage[] | undefined;
    // 只有本次进程新建的对话运行 SessionStart(startup)；恢复既有会话留给 resume 来源。
    let sessionStartedFresh = false;
    if (!smokeTool && args.values['conversation-id'] !== undefined) {
      try {
        ({ session, release: releaseSession } = await openSession(userHome, conversationId, {
          onWarning: (warning) => reportSessionWarning(conversationId, warning),
        }));
        config = await restoreSessionConfig(session.config, process.env);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('会话记录不存在：')) throw error;
        config = await loadCurrentConfig();
        const legacyDirectory = join(process.cwd(), '.agent', 'conversations');
        legacyHistory = await loadLegacyConversation(legacyDirectory, conversationId);
        session = await createSession(userHome, {
          id: conversationId,
          workspace: config.workspace,
          config: persistableSessionConfig(config),
          ...(legacyHistory === undefined ? {} : { transcript: legacyHistory, effectiveHistory: legacyHistory }),
        });
        // 旧版历史已在恢复既有对话；只有记录不存在且无历史时才按新建会话处理。
        sessionStartedFresh = legacyHistory === undefined;
      }
    } else {
      config = await loadCurrentConfig();
      if (smokeTool) session = undefined;
      else {
        session = await createSession(userHome, { id: conversationId, workspace: config.workspace, config: persistableSessionConfig(config) });
        sessionStartedFresh = true;
      }
    }
    // 审批模式是进程级运行状态：切会话不变，重启后重新取 settings；切换不写回配置或会话记录。
    const approvalMode = createApprovalModeState(permissionMode ?? config.approval.mode);
    const currentApprovalMode = (): ApprovalMode => approvalMode.current();
    const executeApprovalModeCommand = (line: string): boolean => {
      const command = parseApprovalModeCommand(line);
      if (command === undefined) return false;
      if (command.mode !== undefined) approvalMode.switchTo(command.mode);
      if (command.invalid !== undefined) {
        process.stdout.write(`\n未知审批模式“${command.invalid}”；可用模式：default、auto、plan。\n`);
      }
      process.stdout.write(`当前审批模式：${approvalModeLabel(currentApprovalMode())}。\n`);
      return true;
    };
    // 信任门禁的交互确认需要输入消费者，因此在 Hook 信任判断之前建立。
    if (!smokeTool) {
      input = new CliInput(
        cancellation.signal,
        cancel,
        config.approval.humanTimeoutMs ?? DEFAULT_HUMAN_APPROVAL_TIMEOUT_MS,
        executeApprovalModeCommand,
        approvalMode,
      );
      config = await applyHookTrust(config);
    }
    if (session && !releaseSession) releaseSession = await acquireSessionLock(userHome, conversationId);
    // 最近读取文件记录跨进程续聊保留；进程内以该记录为准，轮次结束或压缩时持久化。
    const recentFiles = new RecentFileTracker(session?.recentFiles ?? []);
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
      await runTurn({
        prompt: 'smoke',
        config,
        history,
        userHome,
        conversationId,
        signal: AbortSignal.any([cancellation.signal, activeRound.signal]),
        smokeTool: true,
        approvalMode: currentApprovalMode,
      });
      return;
    }
    // 非 smoke 路径在加载配置与 Hook 信任之前已建立输入消费者；此处显式收窄供后续闭包使用。
    if (!input) throw new AgentError('CONFIG_ERROR', '交互输入未初始化。');

    const hookInjectionTracker = new HookInjectionTracker();
    /**
     * 新建对话的 SessionStart(startup) 在任何用户提交之前完成。
     * 匹配 Hook 并行执行，附加上下文按配置顺序放到历史首部；故障只提示，不阻止启动。
     */
    const sessionStartContext = async (source: SessionStartSource, sessionId: string, signal: AbortSignal): Promise<ModelMessage[]> => {
      if (currentApprovalMode() === 'plan' || config.hooks === undefined || config.disableAllHooks) return [];
      const hookInput: SessionStartHookInput = {
        ...hookInputBase('SessionStart', sessionId, sessionRecordPath(userHome, sessionId), config),
        source,
      };
      let result: Awaited<ReturnType<typeof runHookEvent>>;
      try {
        result = await runHookEvent(config.hooks, 'SessionStart', hookInput, {
          cwd: config.workspace,
          env: process.env,
          signal,
          onHookEvent: reportHookEvent,
        });
      } catch {
        process.stderr.write('[hook] SessionStart: 执行失败（已忽略，不影响对话）\n');
        return [];
      }
      for (const run of result.runs) {
        const message = describeHookRun(run);
        if (message !== undefined) process.stderr.write(`${message}\n`);
      }
      return sessionStartContextMessages(result, hookInjectionTracker);
    };
    /** 启动 Hook 期间登记为活动轮次，使 Ctrl-C 能取消；取消后按既有路径关闭输入退出。 */
    const runSessionStart = async (source: SessionStartSource, sessionId: string): Promise<ModelMessage[]> => {
      const controller = new AbortController();
      activeRound = controller;
      try {
        const injected = await sessionStartContext(source, sessionId, AbortSignal.any([cancellation.signal, controller.signal]));
        if (controller.signal.aborted) input?.close();
        return injected;
      } finally {
        activeRound = undefined;
      }
    };
    if (sessionStartedFresh && session) {
      history = [...await runSessionStart('startup', conversationId), ...history];
    } else if (session) {
      // 恢复既有对话：附加上下文接在重建历史尾部，恢复后的下一次请求可见并随有效历史持久化。
      history = [...history, ...await runSessionStart('resume', conversationId)];
    }

    /**
     * 每次真实用户提交进入模型前运行 UserPromptSubmit；该事件没有 matcher query。
     * 附加上下文排在用户消息之后；exit 2 与 decision block 取消本轮，continue false 保留原 prompt。
     */
    const runUserPromptSubmit = async (prompt: string, signal: AbortSignal): Promise<{
      context: ModelMessage[];
      stop?: UserPromptSubmitStop;
    }> => {
      if (currentApprovalMode() === 'plan' || config.hooks === undefined || config.disableAllHooks) return { context: [] };
      const hookInput: UserPromptSubmitHookInput = {
        ...hookInputBase('UserPromptSubmit', conversationId, sessionRecordPath(userHome, conversationId), config),
        prompt,
      };
      let result: Awaited<ReturnType<typeof runHookEvent>>;
      try {
        result = await runHookEvent(config.hooks, 'UserPromptSubmit', hookInput, {
          cwd: config.workspace,
          env: process.env,
          signal,
          onHookEvent: reportHookEvent,
        });
      } catch {
        process.stderr.write('[hook] UserPromptSubmit: 执行失败（已忽略，不影响对话）\n');
        return { context: [] };
      }
      for (const run of result.runs) {
        const message = describeHookRun(run);
        if (message !== undefined) process.stderr.write(`${message}\n`);
      }
      const stop = userPromptSubmitStop(result);
      if (stop) return { context: [], stop };
      return { context: userPromptSubmitContextMessages(result, hookInjectionTracker) };
    };
    /** continue:false 不发出模型请求，但把原 prompt 留在 transcript 与有效历史中。 */
    const preserveUserPrompt = async (prompt: string): Promise<void> => {
      const preserved: ModelMessage = { role: 'user', content: prompt };
      await appendSessionEvent(userHome, conversationId, [preserved]);
      history = [...history, preserved];
    };

    // 启动时注册一次 Skill；会话切换工作区后重新加载，本轮内来源文件变化不影响已注册内容。
    const loadSkills = async (): Promise<SkillCatalogue> => {
      const catalogue = await loadSkillCatalogue({ home: userHome, workspace: config.workspace });
      // 诊断不中断启动，有效 Skill 仍按原规则注册；交互模式显示可读提示，
      // 非交互模式沿用 stderr 的 JSON 事件流，避免破坏可逐行解析的运行日志。
      for (const { path, reason } of catalogue.diagnostics) {
        if (isInteractiveTerminal()) process.stderr.write(`Skill 提示：跳过 ${path}（${reason}）\n`);
        else log({ event: 'skill.skipped', path, reason });
      }
      return catalogue;
    };
    let skills = await loadSkills();
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
    // 压缩附件只读当前会话任务池，不领取结果或改变通知状态。
    const pendingTaskStatuses = (): readonly BackgroundTaskStatusEntry[] => {
      const context = config.context ?? DEFAULT_CONTEXT;
      return backgroundAgentTasksForSession(conversationId, sessionTaskOutputDirectory(userHome, conversationId), context.capacityTokens - context.answerReserveTokens).pendingStatuses();
    };
    const switchSession = async (id: string) => {
      const onWarning = (warning: SessionLoadWarning) => reportSessionWarning(id, warning);
      const opened = id === conversationId ? undefined : await openSession(userHome, id, { onWarning });
      try {
        const session = opened?.session ?? await loadSession(userHome, id, { onWarning, convertLegacy: false });
        const resumed = await resumeSession(session);
        // 恢复对话时从磁盘重新加载 Hook 配置，并按当前配置重新检查信任。
        resumed.config = await applyHookTrust(resumed.config);
        if (opened) {
          await releaseSession?.();
          releaseSession = opened.release;
          fileBaselines = fileBaselinesForSession(id);
        }
        config = resumed.config;
        conversationId = id;
        recentFiles.replace(resumed.recentFiles);
        skills = await loadSkills();
        bindBackgroundNotifications(id);
        // 进程内切换与启动恢复使用同一来源；Hook 配置与信任已在上面按磁盘当前状态重新判定。
        resumed.history = [...resumed.history, ...await runSessionStart('resume', id)];
        process.stdout.write(`已继续会话：${id}（工作区：${resumed.config.workspace}）\n`);
        return resumed;
      } finally {
        // 配置或信任检查失败时保留原会话，释放尚未接管的目标会话。
        if (opened && releaseSession !== opened.release) await opened.release().catch(() => undefined);
      }
    };
    let rewindSelection: { plan: FileRewindPlan } | undefined;
    // 失败或取消的轮次可能已保存压缩检查点；内存历史需与磁盘一致，避免覆盖边界与摘要基数错位。
    const syncHistoryFromSession = async (): Promise<void> => {
      try {
        const recovered = reconstructSessionHistory(await loadSession(userHome, conversationId, {
          onWarning: (warning) => reportSessionWarning(conversationId, warning),
          convertLegacy: false,
        }));
        history = recovered.history;
        recoveredRoundIds = recovered.recoveredRoundIds;
      } catch {
        // 读取失败时保留当前内存历史，不影响已经展示的错误。
      }
    };
    // 命令模型统一保存命令记录；后续 Skill 以 prompt 类型复用同一注册与查找路径。
    const commands = new CommandRegistry();
    await commands.register({
      name: '/clear',
      displayName: '新建会话',
      aliases: ['/new'],
      type: 'local',
      execute: async () => {
        const id = newConversationId();
        await createSession(userHome, { id, workspace: config.workspace, config: persistableSessionConfig(config) });
        const nextRelease = await acquireSessionLock(userHome, id);
        await releaseSession?.();
        releaseSession = nextRelease;
        conversationId = id;
        history = [];
        fileBaselines = fileBaselinesForSession(conversationId);
        recoveredRoundIds = [];
        recentFiles.clear();
        bindBackgroundNotifications(id);
        // /clear 等同新建对话，先完成 SessionStart(startup) 再接受下一条用户提交。
        history = await runSessionStart('startup', id);
        // 新会话就绪后才清屏：中途失败时不抹掉用户窗口。同时清除滚动缓冲区，避免旧对话仍可回看；
        // stdin/stdout 都是 TTY 才写控制序列，管道或重定向输出保持可解析。
        if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[3J\u001b[H');
        process.stdout.write(`已新建会话：${id}\n`);
      },
    });
    await commands.register({
      name: '/exit',
      displayName: '退出',
      aliases: [],
      type: 'local',
      execute: () => ({ exit: true }),
    });
    // 用量只读当前进程内的有效历史，不建立 MCP 连接、不发起模型请求，也不修改会话记录。
    await commands.register({
      name: '/context',
      displayName: '上下文用量',
      aliases: [],
      type: 'local',
      execute: async () => {
        const usage = await estimateContextUsage(config, history, skills, currentApprovalMode() === 'plan');
        process.stdout.write(formatContextUsage(usage, config));
      },
    });
    if (process.stdin.isTTY) input.prompt();
    // 执行中登记的请求由 Agent 在下次主模型请求前消费；空闲时从工作项进入手动压缩。
    const consumeCompactionRequest = (): boolean => input?.consumeCompactRequest() ?? false;
    while (true) {
      const workItem = await input.nextWorkItem(conversationId);
      if (!workItem) break;
      if (workItem.type === 'compact') {
        try {
          activeRound = new AbortController();
          input.setBusy(true);
          history = await compactIdleHistory(config, history, userHome, conversationId, AbortSignal.any([cancellation.signal, activeRound.signal]), legacyDirectory, recentFiles, pendingTaskStatuses, skills);
        } catch (error) {
          if (cancellation.signal.aborted) throw error;
          if (publicError(error).code === 'CANCELLED') process.stdout.write('\n用户中断：Interrupt by user\n');
          else process.stdout.write(`\n${formatUserError(error)}\n`);
        } finally {
          input.setBusy(false);
          activeRound = undefined;
        }
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
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
input.setBusy(true);
          history = await runTurn({
            prompt: notificationPrompt,
            config,
            skills,
            history,
            userHome,
            conversationId,
            signal: AbortSignal.any([cancellation.signal, activeRound.signal]),
            smokeTool: false,
            humanApprovalControl: input.approve,
            legacyDirectory,
            recoveredRoundIds,
            fileBaselines,
            consumeCompactionRequest,
            recentFiles,
            getTaskStatuses: pendingTaskStatuses,
            approvalMode: currentApprovalMode,
            hookInjectionTracker,
          });
          const recovered = reconstructSessionHistory(await loadSession(userHome, conversationId, { convertLegacy: false }));
          history = recovered.history;
          recoveredRoundIds = recovered.recoveredRoundIds;
        } catch (error) {
          if (cancellation.signal.aborted) throw error;
          process.stdout.write(`\n${formatUserError(error)}\n`);
          await syncHistoryFromSession();
        } finally {
          input.setBusy(false);
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
          const refreshed = await prepareFileRewind(await loadSession(userHome, conversationId, { convertLegacy: false }), rewindSelection.plan.checkpoint.id);
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
      const command = commands.find(prompt);
      if (command?.type === 'local') {
        const outcome = await command.execute();
        if (outcome && outcome.exit) break;
        if (process.stdin.isTTY) input.prompt();
        continue;
      }
      if (prompt === '/rewind') {
        const currentSession = await loadSession(userHome, conversationId, { convertLegacy: false });
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
              const plan = await prepareFileRewind(await loadSession(userHome, conversationId, { convertLegacy: false }), checkpointId);
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
          detail: sessionChoiceDetail(session),
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
              detail: sessionChoiceDetail(session),
              value: session.id,
            }));
            const selectedId = await input.select('全部工作区会话', allChoices);
            if (selectedId) {
              try { ({ config, conversationId, history, recoveredRoundIds } = await switchSession(selectedId)); }
              catch (error) { process.stdout.write(`\n${formatUserError(error)}\n`); }
            }
          } else if (id?.kind === 'session') {
            try { ({ config, conversationId, history, recoveredRoundIds } = await switchSession(id.id)); }
            catch (error) { process.stdout.write(`\n${formatUserError(error)}\n`); }
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
          process.stdout.write(`\n${formatUserError(error)}\n`);
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
        input.setBusy(true);
        const turnSignal = AbortSignal.any([cancellation.signal, activeRound.signal]);
const submitted = await runUserPromptSubmit(prompt, turnSignal);
        turnSignal.throwIfAborted();
        if (submitted.stop) {
          if (submitted.stop.kind === 'stop') await preserveUserPrompt(prompt);
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        history = await runTurn({
          prompt,
          config,
          skills,
          history,
          userHome,
          conversationId,
          signal: turnSignal,
          smokeTool: false,
          humanApprovalControl: input.approve,
          legacyDirectory,
          recoveredRoundIds,
          fileBaselines,
          consumeCompactionRequest,
          recentFiles,
          getTaskStatuses: pendingTaskStatuses,
          approvalMode: currentApprovalMode,
          promptContext: submitted.context,
          hookInjectionTracker,
        });
        const recovered = reconstructSessionHistory(await loadSession(userHome, conversationId, { convertLegacy: false }));
        history = recovered.history;
        recoveredRoundIds = recovered.recoveredRoundIds;
      } catch (error) {
        if (cancellation.signal.aborted) throw error;
        const failure = publicError(error);
        process.stdout.write(`\n${formatUserError(failure)}\n`);
        await syncHistoryFromSession();
      } finally {
        input.setBusy(false);
        activeRound = undefined;
      }
      if (process.stdin.isTTY) input.prompt();
    }
    cancellation.signal.throwIfAborted();
  } catch (error) {
    const failure = publicError(error);
    if (isInteractiveTerminal()) process.stderr.write(`${formatUserError(failure)}\n`);
    else {
      log({
        event: 'run.finished', runId: lastRunId, status: 'failed',
        durationMs: Math.round(performance.now() - lastRunStartedAt),
        error: { code: failure.code, message: failure.message },
      });
    }
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

/**
 * 空闲时手动压缩：总结当前有效历史并立即保存，不发起主模型续做请求。
 * 复用会话模型配置与整轮执行时限；失败时保留压缩前历史并返回输入。
 */
async function compactIdleHistory(
  config: Awaited<ReturnType<typeof loadConfig>>,
  history: ModelMessage[],
  userHome: string,
  conversationId: string,
  signal: AbortSignal,
  legacyDirectory: string | undefined,
  recentFiles: RecentFileTracker,
  getTaskStatuses: () => readonly BackgroundTaskStatusEntry[],
  skills: SkillCatalogue | undefined,
): Promise<ModelMessage[]> {
  if (history.length === 0) {
    process.stdout.write('当前会话没有可压缩的历史。\n');
    return history;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new AgentError('TIMEOUT', `请求超过 ${config.timeoutMs}ms，已终止。`)), config.timeoutMs);
  let langfuseTracer: LangfuseTracer | undefined;
  let langfuseTrace: TraceHandle | undefined;
  try {
    // 跟踪器构造失败也走正常错误路径，避免遗留未清理的执行时限定时器。
    langfuseTracer = createLangfuseTracer({ config, env: process.env, sessionId: conversationId });
    langfuseTrace = langfuseTracer?.startTrace({
      name: 'conversation.compact',
      metadata: { conversationId, model: config.model, messageCount: history.length },
    });
    const tracing = langfuseTracer === undefined || langfuseTrace === undefined
      ? undefined
      : { tracer: langfuseTracer, traceId: langfuseTrace.id };
    const observations = new AgentObservations(tracing);
    // 空闲压缩与自动压缩共用 Skill 恢复路径，按会话记录中的最近加载顺序补回被摘要移除的正文。
    const current = await loadSession(userHome, conversationId, { convertLegacy: false });
    const restore = skills === undefined
      ? undefined
      : {
        catalogue: skills,
        recentLoads: current.skillLoads ?? [],
        ...(current.skillBodies === undefined ? {} : { bodies: current.skillBodies }),
      };
    const summary = await observations.traceSummary(
      history.length,
      (childTracing) => generateSummary(config, history, AbortSignal.any([signal, deadline.signal]), sessionRecordPath(userHome, conversationId), {
        recentFiles: recentFiles.list(),
        getTaskStatuses,
        ...(restore === undefined ? {} : { restore }),
        ...(childTracing === undefined ? {} : { tracing: childTracing }),
      }),
      (result) => result.text,
    );
    await saveManualCompaction(userHome, conversationId, {
      effectiveHistory: summary.compacted,
      summary: { text: summary.text, restoredMessages: summary.restoredMessages },
      recentFiles: recentFiles.list(),
    });
    if (legacyDirectory) await saveLegacyConversation(legacyDirectory, conversationId, summary.compacted).catch(() => undefined);
    langfuseTrace?.end({
      output: summary.text,
      status: 'succeeded',
      metadata: { compactedMessages: summary.compacted.length, restoredMessages: summary.restoredMessages },
    });
    process.stdout.write('已压缩当前会话历史。\n');
    return summary.compacted;
  } catch (error) {
    langfuseTrace?.end({
      status: signal.aborted ? 'cancelled' : 'failed',
      error: { message: error instanceof Error ? error.message : '手动压缩失败。' },
    });
    throw error;
  } finally {
    clearTimeout(timer);
    // 上报在后台完成：Langfuse 不可达或超时不能延迟返回输入提示符。
    void langfuseTracer?.flush();
  }
}

/** Stop 的反馈与续跑结论；第二次运行只观察日志，不使用其中的反馈。 */
interface StopHookOutcome {
  feedback: ModelMessage[];
  continuation: boolean;
}

/**
 * Stop 在 runAgent 成功返回后、finishSessionRound 之前运行。
 * 该事件没有 matcher query，默认超时 60 秒；block 或 exit 2 的理由追加到有效历史末端。
 * stopHookActive 标记本次运行是否由上一次 Stop 阻止后的续跑触发。
 */
async function runStopHook(
  config: Awaited<ReturnType<typeof loadConfig>>,
  conversationId: string,
  userHome: string,
  text: string,
  signal: AbortSignal,
  tracker: HookInjectionTracker,
  stopHookActive: boolean,
  approvalMode?: () => ApprovalMode,
): Promise<StopHookOutcome> {
  if ((approvalMode?.() ?? config.approval.mode) === 'plan'
    || config.hooks === undefined || config.disableAllHooks) return { feedback: [], continuation: false };
  // 最终回答之后、Hook 启动之前的取消仍属于取消路径，不运行 Stop。
  signal.throwIfAborted();
  const hookInput: StopHookInput = {
    ...hookInputBase('Stop', conversationId, sessionRecordPath(userHome, conversationId), config),
    stop_hook_active: stopHookActive,
    last_assistant_message: text,
  };
  let result: Awaited<ReturnType<typeof runHookEvent>>;
  try {
    result = await runHookEvent(config.hooks, 'Stop', hookInput, {
      cwd: config.workspace,
      env: process.env,
      signal,
      onHookEvent: reportHookEvent,
    });
  } catch {
    process.stderr.write('[hook] Stop: 执行失败（已忽略，不影响本轮）\n');
    return { feedback: [], continuation: false };
  }
  for (const run of result.runs) {
    const message = describeHookRun(run);
    if (message !== undefined) process.stderr.write(`${message}\n`);
  }
  // 用户在 Hook 执行期间取消时不把本轮记为成功，也不保存反馈。
  signal.throwIfAborted();
  return {
    feedback: stopFeedbackMessages(result, tracker),
    continuation: stopContinuation(result),
  };
}

interface TurnOptions {
  prompt: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  skills?: SkillCatalogue;
  history: ModelMessage[];
  userHome: string;
  conversationId: string;
  signal: AbortSignal;
  smokeTool: boolean;
  /** CLI 人工审批控制；仅在当前模式为 default 时使用。 */
  humanApprovalControl?: ApprovalControl;
  /** 当前进程的审批模式；每个工具调用进入审批前读取。 */
  approvalMode?: () => ApprovalMode;
  legacyDirectory?: string;
  recoveredRoundIds?: string[];
  fileBaselines?: Map<string, WorkspaceFileSnapshot>;
  consumeCompactionRequest?: () => boolean;
  recentFiles?: RecentFileTracker;
  getTaskStatuses?: () => readonly BackgroundTaskStatusEntry[];
  /** 本轮首次模型请求之前的附加上下文（UserPromptSubmit Hook）；续跑不重复注入。 */
  promptContext?: ModelMessage[];
  /** 首次运行与 Stop 续跑共享的 Hook 注入去重集合。 */
  hookInjectionTracker?: HookInjectionTracker;
}

async function runTurn(options: TurnOptions): Promise<ModelMessage[]> {
  const {
    prompt, config, skills, history, userHome, conversationId, signal, smokeTool,
    humanApprovalControl, approvalMode, legacyDirectory,
    recoveredRoundIds = [], fileBaselines = new Map<string, WorkspaceFileSnapshot>(),
    consumeCompactionRequest, recentFiles = new RecentFileTracker(), getTaskStatuses,
    promptContext = [], hookInjectionTracker,
  } = options;
  let roundId: string | undefined;
  let summaryCoverageBase = 0;
  let summaryRestoredBase = 0;
  let recentSkillLoads: string[] = [];
  let skillBodies: Record<string, string> = {};
  let bashFailed = false;
  let manualCompaction = false;
  // 交互终端按模型步聚合工具活动；非交互管道继续使用下方逐行事件。
  const toolActivity = new ToolActivityRenderer(process.stdout);
  const toolInputs = new Map<string, { toolName: string; input: unknown }>();
  let langfuseTracer: LangfuseTracer | undefined;
  let langfuseTrace: TraceHandle | undefined;
  lastRunId = randomUUID();
  lastRunStartedAt = performance.now();
  log({
    event: 'run.started', runId: lastRunId, status: 'running', config: loggableConfig(config), smokeTool,
    ...(smokeTool ? {} : { conversationId }),
  });
  try {
    if (!smokeTool) {
      roundId = await startSessionRound(userHome, conversationId, prompt, persistableSessionConfig(config), () => {
        reportCheckpointWarning('checkpoint.snapshot_failed', '消息检查点文件快照失败，本轮继续处理。', { conversationId });
      });
      const current = await loadSession(userHome, conversationId, { convertLegacy: false });
      const lastSummary = current.summaries.at(-1);
      summaryCoverageBase = lastSummary?.coversThrough ?? 0;
      summaryRestoredBase = lastSummary?.restoredMessages ?? 0;
      recentSkillLoads = current.skillLoads ?? [];
      skillBodies = current.skillBodies ?? {};
    }
    // 默认关闭时 tracer 为 undefined；启用后每轮是独立 trace，会话 ID 关联同一对话。
    langfuseTracer = createLangfuseTracer({ config, env: process.env, sessionId: conversationId });
    langfuseTrace = langfuseTracer?.startTrace({
      name: 'agent.round',
      input: prompt,
      metadata: {
        conversationId,
        ...(roundId === undefined ? {} : { roundId }),
        workspace: config.workspace,
        model: config.model,
        smokeTool,
      },
    });
    const tracing = langfuseTracer === undefined || langfuseTrace === undefined
      ? undefined
      : { tracer: langfuseTracer, traceId: langfuseTrace.id };
    const runAgentTurn = (
      agentPrompt: string | undefined,
      agentHistory: ModelMessage[],
      turnOptions: {
        promptContext: ModelMessage[];
        maxSteps?: number;
        summaryCoverageBase?: number;
        summaryRestoredBase?: number;
        recentSkillLoads?: readonly string[];
        skillBodies?: Readonly<Record<string, string>>;
      },
    ) => runAgent(config, agentPrompt, {
      smokeTool,
      ...(tracing === undefined ? {} : { tracing }),
      history: agentHistory,
      promptContext: turnOptions.promptContext,
      summaryCoverageBase: turnOptions.summaryCoverageBase ?? summaryCoverageBase,
      summaryRestoredBase: turnOptions.summaryRestoredBase ?? summaryRestoredBase,
      recentSkillLoads: turnOptions.recentSkillLoads ?? recentSkillLoads,
      skillBodies: turnOptions.skillBodies ?? skillBodies,
      ...(turnOptions.maxSteps === undefined ? {} : { maxSteps: turnOptions.maxSteps }),
      fileBaselines,
      ...(skills === undefined ? {} : { skills }),
      ...(!smokeTool ? { backgroundTasks: backgroundAgentTasksForSession(
        conversationId,
        sessionTaskOutputDirectory(userHome, conversationId),
        (config.context ?? DEFAULT_CONTEXT).capacityTokens - (config.context ?? DEFAULT_CONTEXT).answerReserveTokens,
      ) } : {}),
      onText: async (chunk) => {
        if (!smokeTool && roundId) await appendRoundText(userHome, conversationId, roundId, chunk);
        // 模型开始输出前固定工具块，后续文本不会再触发块内重绘。
        toolActivity.flush();
        process.stdout.write(chunk);
      },
      ...(!smokeTool ? { transcriptPath: sessionRecordPath(userHome, conversationId), sessionId: conversationId } : {}),
      ...(hookInjectionTracker === undefined ? {} : { hookInjectionTracker }),
      onHookEvent: reportHookEvent,
      onFileRead: (target) => recentFiles.record(target),
      getRecentFiles: () => recentFiles.list(),
      ...(getTaskStatuses ? { getTaskStatuses } : {}),
      onToolCallStart: async ({ callId, toolName, input }) => {
        toolInputs.set(callId, { toolName, input });
        if (!smokeTool && roundId) {
          await appendRoundMessages(userHome, conversationId, roundId, [{
            role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName, input }],
          } as unknown as ModelMessage]);
        }
      },
      onStepMessages: async (content) => {
        // 本步所有工具结果已确定，结束活动块并保留最终状态。
        toolActivity.flush();
        if (smokeTool || !roundId) return;
        const results = content.filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null && (part as { type?: string }).type === 'tool-result');
        if (results.length > 0) await appendRoundMessages(userHome, conversationId, roundId, [{ role: 'tool', content: results } as unknown as ModelMessage]);
      },
      onCompaction: async (checkpoint) => {
        // 摘要成功即保存，不等待本轮最终结果；后续失败或取消仍可跨进程续聊压缩历史。
        if (!roundId) return;
        const saved = await saveCompactionCheckpoint(userHome, conversationId, roundId, { ...checkpoint, recentFiles: recentFiles.list() });
        if (manualCompaction) {
          manualCompaction = false;
          process.stdout.write('\n已压缩当前会话历史。\n');
        }
        return saved;
      },
      onBeforeWrite: async (snapshot: WorkspaceFileSnapshot) => {
        if (!roundId) return;
        await recordFileBackup(userHome, conversationId, roundId, snapshot);
      },
      onCheckpointError: () => {
        reportCheckpointWarning('checkpoint.backup_failed', 'write_file 原状态备份失败，继续写入。', { conversationId });
      },
      onToolEvent: ({ callId, toolName, description, status }) => {
        if (toolName === 'Bash' && status === 'failed') bashFailed = true;
        if (toolActivity.enabled) {
          const input = toolInputs.get(callId)?.input;
          if (status === 'started') toolActivity.start(callId, toolName, input);
          else {
            toolActivity.finish(callId, toolName, input, status);
            toolInputs.delete(callId);
          }
          return;
        }
        toolInputs.delete(callId);
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
      ...(consumeCompactionRequest ? { consumeCompactionRequest: () => {
        const requested = consumeCompactionRequest();
        if (requested) manualCompaction = true;
        return requested;
      } } : {}),
      // 人工控制只在当前模式为 default 或 plan 时生效；运行时切换后，后续调用按新模式的审批方式接管。
      ...(humanApprovalControl === undefined ? {} : { humanApprovalControl }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
    });

    const firstResult = await runAgentTurn(prompt, history, { promptContext });
    signal.throwIfAborted();
    const tracker = hookInjectionTracker ?? new HookInjectionTracker();
    // Stop 只在最终回答产生后、轮次结束前运行；取消与异常终止都在调用前抛错。
    const stop = smokeTool
      ? { feedback: [] as ModelMessage[], continuation: false }
      : await runStopHook(config, conversationId, userHome, firstResult.text, signal, tracker, false, approvalMode);
    const stopFeedback = stop.feedback;
    let finalResult = firstResult;
    let roundMessages = firstResult.roundMessages;
    let summaries = [...firstResult.summaries];
    let skillLoads = [...firstResult.skillLoads];
    let mergedSkillBodies = { ...firstResult.skillBodies };
    let totalSteps = firstResult.steps;
    let totalToolCalls = firstResult.toolCalls;
    let totalUsage = firstResult.usage;
    let nextHistory = smokeTool ? history : [...firstResult.effectiveHistory, ...stopFeedback];
    if (!smokeTool && stop.continuation) {
      // 续跑复用整轮剩余步数，而不是重新获得完整额度。
      const remainingSteps = config.maxSteps - firstResult.steps;
      if (remainingSteps <= 0) {
        process.stderr.write('[hook] Stop: 已达到本轮步数上限，不再续跑\n');
      } else {
        // 第一次运行可能已写压缩检查点；续跑从磁盘读取最新摘要边界与 Skill 状态。
        const current = await loadSession(userHome, conversationId, { convertLegacy: false });
        const lastSummary = current.summaries.at(-1);
        const resumed = await runAgentTurn(undefined, [...firstResult.effectiveHistory, ...stopFeedback], {
          promptContext: [],
          maxSteps: remainingSteps,
          summaryCoverageBase: lastSummary?.coversThrough ?? 0,
          summaryRestoredBase: lastSummary?.restoredMessages ?? 0,
          recentSkillLoads: appendRecentSkillLoads(current.skillLoads ?? [], firstResult.skillLoads),
          skillBodies: { ...current.skillBodies, ...firstResult.skillBodies },
        });
        signal.throwIfAborted();
        // 第二次 Stop 只记录日志：再次 block 也不续跑，也不向历史注入新的反馈。
        await runStopHook(config, conversationId, userHome, resumed.text, signal, tracker, true, approvalMode);
        finalResult = resumed;
        roundMessages = [...roundMessages, ...stopFeedback, ...resumed.roundMessages];
        summaries = [...summaries, ...resumed.summaries];
        skillLoads = appendRecentSkillLoads(skillLoads, resumed.skillLoads);
        mergedSkillBodies = { ...mergedSkillBodies, ...resumed.skillBodies };
        nextHistory = resumed.effectiveHistory;
        totalSteps += resumed.steps;
        totalToolCalls += resumed.toolCalls;
        totalUsage = {
          inputTokens: sumTokens(firstResult.usage.inputTokens, resumed.usage.inputTokens),
          outputTokens: sumTokens(firstResult.usage.outputTokens, resumed.usage.outputTokens),
        };
      }
    }
    if (!smokeTool) {
      if (!roundId) throw new AgentError('PROVIDER_ERROR', '当前轮次未能建立持久化记录。');
      await finishSessionRound(userHome, conversationId, roundId, {
        status: 'succeeded', response: roundMessages, effectiveHistory: nextHistory,
        summaries, recoveredRoundIds, recentFiles: recentFiles.list(),
        skillLoads, skillBodies: mergedSkillBodies,
      });
      if (legacyDirectory) await saveLegacyConversation(legacyDirectory, conversationId, nextHistory).catch(() => undefined);
    }
    toolActivity.flush();
    if (bashFailed) process.stdout.write('\n注意：本轮 Bash 命令执行失败，回复未获命令验证。\n');
    langfuseTrace?.end({
      output: finalResult.text,
      status: 'succeeded',
      metadata: {
        steps: totalSteps,
        toolCalls: totalToolCalls,
        finishReason: finalResult.finishReason,
        toolSmokePassed: finalResult.toolSmokePassed,
      },
    });
    // 上报在后台完成：不延迟下一轮输入提示符；待发送请求由事件循环保持到结束。
    void langfuseTracer?.flush();
    process.stdout.write('\n');
    log({
      event: 'run.finished', runId: lastRunId, status: 'succeeded',
      durationMs: Math.round(performance.now() - lastRunStartedAt),
      steps: totalSteps, toolCalls: totalToolCalls,
      finishReason: finalResult.finishReason, usage: totalUsage,
      toolSmokePassed: finalResult.toolSmokePassed,
      ...(smokeTool ? {} : { conversationId }),
    });
    return nextHistory;
  } catch (error) {
    toolActivity.flush();
    const failure = publicError(error);
    const interrupted = failure.code === 'CANCELLED' && failure.message === 'Interrupt by user';
    if (interrupted && !smokeTool && roundId) {
      await finishSessionRound(userHome, conversationId, roundId, {
        status: 'cancelled', error: { code: 'CANCELLED', message: 'Interrupt by user' }, recentFiles: recentFiles.list(),
      }).catch(() => undefined);
      process.stdout.write('\n用户中断：Interrupt by user\n');
      langfuseTrace?.end({ status: 'cancelled', error: { code: 'CANCELLED', message: 'Interrupt by user' } });
      void langfuseTracer?.flush();
      log({ event: 'run.finished', runId: lastRunId, status: 'cancelled', durationMs: Math.round(performance.now() - lastRunStartedAt), conversationId });
      return history;
    }
    if (!smokeTool && roundId) {
      await finishSessionRound(userHome, conversationId, roundId, {
        status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
        error: { code: failure.code, message: failure.message }, recentFiles: recentFiles.list(),
      }).catch(() => undefined);
    }
    if (!smokeTool) {
      log({
        event: 'run.finished', runId: lastRunId, status: 'failed',
        durationMs: Math.round(performance.now() - lastRunStartedAt),
        error: { code: failure.code, message: failure.message }, conversationId,
      });
    }
    langfuseTrace?.end({
      status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
      error: { code: failure.code, message: failure.message },
    });
    void langfuseTracer?.flush();
    throw error;
  }
}

/** 合并两次运行的 token 用量；两边都未提供时保持未知，而不是伪造为 0。 */
function sumTokens(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) return undefined;
  return (first ?? 0) + (second ?? 0);
}

function parseCliArgs() {
  return parseArgs({
    options: {
      workspace: { type: 'string' },
      'conversation-id': { type: 'string' },
      'permission-mode': { type: 'string' },
      'smoke-tool': { type: 'boolean' },
      'trust-hooks': { type: 'boolean' },
      'no-hooks': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
}

await main();

async function resumeSession(session: SessionRecord): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  conversationId: string;
  history: ModelMessage[];
  recoveredRoundIds: string[];
  recentFiles: string[];
}> {
  const config = await restoreSessionConfig(session.config, process.env);
  const recovered = reconstructSessionHistory(session);
  return { config, conversationId: session.id, ...recovered, recentFiles: session.recentFiles };
}

function userMessageText(message: ModelMessage): string {
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
      : '';
  return text.trim();
}
