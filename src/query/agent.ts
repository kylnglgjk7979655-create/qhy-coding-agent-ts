import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, InvalidToolInputError, isStepCount, NoSuchToolError, ToolChoiceViolationError, ToolLoopAgent, wrapLanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ApprovalMode, ResolvedConfig } from '../services/settings/config.js';
import { AgentError, publicError } from '../utils/errors.js';
import { estimateInput, toolDefinitionsForEstimate } from '../utils/input-estimate.js';
import { validatedOpenAIFetch } from '../services/api/openai-sse-fetch.js';
import type { WorkspaceFileBaselines, WorkspaceFileSnapshot } from '../tools/workspace-files.js';
import { approveToolCall } from '../tools/tool-approval.js';
import type { ApprovalControl } from '../tools/tool-approval.js';
import { resolveApproval } from '../tools/approval-mode.js';
import { MAX_TOOL_CALL_CONCURRENCY, ToolRegistry } from '../tools/tool-registry.js';
import { registerBuiltInTools } from '../tools/register-built-in-tools.js';
import { bashSandboxGuidance } from '../tools/BashTool/sandbox-guidance.js';
import { registerRemoteMCP } from '../services/mcp/remote-mcp.js';
import { DEFAULT_CONTEXT, DEFAULT_SANDBOX } from '../services/settings/config.js';
import { prepareConversation } from '../services/compact/context-summary.js';
import { appendRecentSkillLoads, collectSkillInjections, insertSkillInjections } from '../services/skills/skill-injection.js';
import type { SkillCatalogue } from '../services/skills/skill-registry.js';
import type { SkillInjection } from '../services/skills/skill-injection.js';
import type { ToolExecutionEvent } from '../tools/tool-registry.js';
import {
  HookInjectionTracker, describeHookRun, evaluatePreToolUse, hookInputBase, runHookEvent,
  takeToolFeedbackMessages, toolPreToolUseDecision,
} from '../services/hooks/hook-engine.js';
import type { HookEventNotification, HookEventResult } from '../services/hooks/hook-engine.js';
import type { ParentHookScope, SubagentHookScope } from '../services/hooks/hook-scope.js';
import type { PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput } from '../services/hooks/hook-runner.js';
import type { BackgroundAgentTasks, BackgroundTaskStatusEntry } from '../tools/AgentTool/background-agent-tasks.js';
import { AgentObservations } from '../services/observability/agent-observations.js';
import type { TracingScope } from '../services/observability/langfuse.js';

export type { ApprovalControl } from '../tools/tool-approval.js';
export type { ToolApprovalRequest } from '../tools/tool-registry.js';
export type { ToolExecutionEvent } from '../tools/tool-registry.js';

export interface RunResult {
  text: string;
  responseMessages: ModelMessage[];
  /** 本轮完整消息序列，Skill 正文注入排在对应工具结果之后，供会话记录保存本轮原文。 */
  roundMessages: ModelMessage[];
  /** 本轮实际注入的 Skill 规范名称，按加载顺序；同一 Skill 只保留最近一次位置。 */
  skillLoads: string[];
  /** 本轮各规范名最近实际注入的完整正文；随成功轮次保存。 */
  skillBodies: Record<string, string>;
  /** 本轮成功使用的完整有效历史，可直接用于保存及下一轮输入。 */
  effectiveHistory: ModelMessage[];
  summaries: Array<{ text: string; coversThrough: number; /** 该摘要恢复的 Skill 正文条数，不计入覆盖边界。 */ restoredMessages?: number }>;
  steps: number;
  toolCalls: number;
  finishReason: string;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  toolSmokePassed: boolean;
}

function modelStreamError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (APICallError.isInstance(error) || ToolChoiceViolationError.isInstance(error)) return publicError(error);
  return new AgentError('PROVIDER_ERROR', '模型响应流无效，已终止当前对话轮次。');
}

/** 主 Agent 的内置系统提示；/context 使用同一构造，保证估算口径与真实请求一致。 */
function buildInstructions(config: ResolvedConfig, options: {
  generalPurposeSubagent?: boolean;
  skills?: SkillCatalogue;
}): string {
  return [
    '你是基础 CLI Agent。请直接回答用户需求，默认使用中文。',
    '搜索文件路径时优先使用 Glob，搜索文件内容时优先使用 Grep；两者默认搜索整个工作区，也可限定子目录，遵循 .gitignore 并包含隐藏目录。旧的 glob、grep 名称仍可使用。',
    '使用 Read 读取文件（file_path，可选 offset、limit）：工作区内默认允许，工作区外需要审批；使用 Write 创建或完整重写文件（file_path、content）；使用 Edit 在单个文件中把 old_string 替换为 new_string，编辑前需先读取目标文件，默认要求唯一匹配，replace_all: true 时替换全部匹配。Write 与 Edit 默认需要审批。',
    'read_file、write_file 保留为兼容旧名称，参数分别为 path 与 path/content。Read、Write 权限规则按请求路径和实际目标执行。',
    '可用 TodoWrite 记录本次任务的待办列表；调用会以完整列表替换旧状态，最多一个任务处于 in_progress。',
    'WebFetch 只访问公开 HTTP/HTTPS 地址并拒绝本机、内网与云 metadata 地址；WebSearch 使用 Tavily，凭据从环境变量读取。两者默认需要独立审批。',
    'Write、write_file、Edit、Bash、WebFetch、WebSearch 默认需要独立审批，批准只适用于当前调用及参数；权限拒绝不会执行操作。',
    `Bash 可运行命令和项目测试，每次使用独立 shell。${bashSandboxGuidance(config.permissions?.sandbox ?? DEFAULT_SANDBOX)}`,
    '工具结果中的 is_error: true 表示该调用失败；必须在答复中明确说明失败，不得声称操作成功或把失败调用的输出当成已验证结果。',
    'runtimeInfo 可获取工作区路径和本次探针。',
    '如公布了 mcp_ 前缀工具，可调用对应远程 MCP 服务；这些工具默认需要独立审批，调用可能产生远端副作用。',
    '参数已知且彼此无依赖的工具调用尽量放在同一批；需要前序调用结果的工具调用应分批。',
    ...(options.generalPurposeSubagent ? [
      '你是 general-purpose 子 Agent，负责独立完成委派的研究或多步骤修改任务。',
      '你不能再委派子 Agent。',
    ] : []),
    ...(options.skills === undefined || options.skills.skills.length === 0 ? [] : [
      '可用 skill 工具按规范名称、显示名称或别名加载 Skill；工具结果只表示调用成功，正文由后续消息提供。',
      options.skills.instructions,
    ]),
  ].join('\n');
}

/** 发送前估算结果；与主模型请求共用同一估算口径，不代表服务端精确 token 计数。 */
export interface ContextUsageEstimate {
  readonly estimatedInputTokens: number;
  readonly capacityTokens: number;
  readonly usageRatio: number;
}

/**
 * 估算当前有效历史对应的输入占用，包含系统提示与可用内置工具定义。
 * 仅在本进程内构造定义，不连接远程 MCP 服务，因此配置的 MCP 工具定义不计入。
 */
export async function estimateContextUsage(
  config: ResolvedConfig,
  history: readonly ModelMessage[],
  skills?: SkillCatalogue,
): Promise<ContextUsageEstimate> {
  const registry = new ToolRegistry({});
  registerBuiltInTools(registry, {
    config,
    probe: '',
    allowAgent: true,
    fileWriteCallbacks: {},
    bashOperations: new Set(),
    ...(skills === undefined ? {} : { skills }),
  });
  const tools = registry.tools();
  const definitions = await toolDefinitionsForEstimate(tools);
  const capacityTokens = (config.context ?? DEFAULT_CONTEXT).capacityTokens;
  const estimatedInputTokens = estimateInput(buildInstructions(config, skills === undefined ? {} : { skills }), history, definitions);
  return { estimatedInputTokens, capacityTokens, usageRatio: estimatedInputTokens / capacityTokens };
}

/**
 * prompt 省略时只以 history 发起请求，供 Stop 阻止后的续跑复用同一轮有效历史，
 * 不再追加新的用户消息。
 */
export async function runAgent(
  config: ResolvedConfig,
  prompt: string | undefined,
  options: {
    smokeTool: boolean;
    history?: ModelMessage[];
    /** 覆盖本次运行的步数上限；Stop 续跑传入整轮剩余步数。 */
    maxSteps?: number;
    /** 用户消息之后的 Hook 附加上下文；只进入第一次模型请求并随有效历史持久化。 */
    promptContext?: readonly ModelMessage[];
    onText?: (chunk: string) => Promise<void> | void;
    onToolCallStart?: (call: { callId: string; toolName: string; input: unknown }) => Promise<void> | void;
    onStepMessages?: (content: unknown[]) => Promise<void> | void;
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
    fileBaselines?: WorkspaceFileBaselines;
    onToolCall?: (name: string) => void;
    onToolEvent?: (event: ToolExecutionEvent) => unknown;
    signal?: AbortSignal;
    approvalControl?: ApprovalControl;
    /** CLI 人工审批控制；仅在当前模式为 default 时使用。 */
    humanApprovalControl?: ApprovalControl;
    /** 当前进程的审批模式；省略时沿用配置模式。每次工具调用进入审批前读取。 */
    approvalMode?: () => ApprovalMode;
    /** 摘要成功后立即持久化压缩检查点；保存失败按停止本轮处理，不报告压缩成功。 */
    onCompaction?: (checkpoint: {
      effectiveHistory: ModelMessage[];
      summary: { text: string; restoredMessages?: number };
    }) => Promise<{ coversThrough: number } | void> | { coversThrough: number } | void;
    /** 会话原始记录路径，写入摘要续接包装供后续找回细节；子 Agent 没有会话记录时省略。 */
    transcriptPath?: string;
    /** 工具 Hook 的对话标识；smoke 与尚未接入会话范围的子 Agent 省略时，不运行工具 Hook。 */
    sessionId?: string;
    /**
     * 子 Agent 的工具 Hook 范围：沿用父对话的 session_id 与记录路径，并附加 agent_id/agent_type。
     * 省略时按主 Agent 处理，从 sessionId/transcriptPath 推导范围。
     */
    hookScope?: SubagentHookScope;
    /** 与对话共享的注入去重集合；省略时本次运行自行创建。 */
    hookInjectionTracker?: HookInjectionTracker;
    /** 独立于工具事件的 Hook 观测回调；失败只写 stderr，不改变 Hook 或模型流程。 */
    onHookEvent?: (notification: HookEventNotification) => unknown;
    /** 成功读取文件后刷新最近文件顺序；子 Agent 没有会话记录时省略。 */
    onFileRead?: (target: string) => void;
    /** 压缩时提供当前最近读取文件候选；子 Agent 没有会话记录时省略。 */
    getRecentFiles?: () => readonly string[];
    /** 压缩时提供待关注的后台任务状态；只读，不领取结果或改变通知状态。 */
    getTaskStatuses?: () => readonly BackgroundTaskStatusEntry[];
    /** 执行中登记的手动压缩请求；在工具结果写入后、下一次主模型请求前取出并强制压缩。 */
    consumeCompactionRequest?: () => boolean;
    summaryCoverageBase?: number;
    /** 上一份摘要恢复的正文条数；这些消息不在 transcript 中，计算覆盖边界时要扣除。 */
    summaryRestoredBase?: number;
    /** general-purpose 子 Agent 使用独立循环，但不公布 agent 工具。 */
    generalPurposeSubagent?: boolean;
    modelOverride?: string;
    backgroundTasks?: BackgroundAgentTasks;
    /** 已注册 Skill 的共享清单；主 Agent 与子 Agent 使用同一份。 */
    skills?: SkillCatalogue;
    /** 会话记录中此前实际加载的 Skill 规范名称，按加载顺序；用于压缩后恢复正文。 */
    recentSkillLoads?: readonly string[];
    /** 先前成功加载的正文快照，避免同规范名记录在恢复时被重新解析为另一来源。 */
    skillBodies?: Readonly<Record<string, string>>;
    /** 本轮 Langfuse 跟踪；子 Agent 的 scope 指向其 subagent span。 */
    tracing?: TracingScope;
  },
): Promise<RunResult> {
  const stepLimit = options.maxSteps ?? config.maxSteps;
  if (options.smokeTool && stepLimit < 2) {
    throw new AgentError('CONFIG_ERROR', '工具冒烟需要 maxSteps >= 2，以完成工具调用及后续回答。');
  }

  const provider = createOpenAI({
    apiKey: config.apiKey,
    fetch: validatedOpenAIFetch,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
  });
  const probe = randomUUID();
  const smokeProbePath = `.agent-smoke-${probe}.txt`;
  if (options.smokeTool) await writeFile(join(config.workspace, smokeProbePath), probe, { encoding: 'utf8', flag: 'wx' });
  const frameworkAbort = new AbortController();
  const bashOperations = new Set<Promise<unknown>>();
  let frameworkError: AgentError | undefined;
  const deadline = new AbortController();
  const pairingAbort = new AbortController();
  let pairingError: AgentError | undefined;
  let remainingMs = config.timeoutMs;
  let deadlinePauseDepth = 0;
  let activeSince = performance.now();
  let timer = setTimeout(() => deadline.abort(), remainingMs);
  const signal = options.signal === undefined
    ? AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal])
    : AbortSignal.any([deadline.signal, pairingAbort.signal, frameworkAbort.signal, options.signal]);
  let preparedHistory: ModelMessage[] = [];
  function pauseDeadline(): void {
    signal.throwIfAborted();
    deadlinePauseDepth += 1;
    if (deadlinePauseDepth > 1) return;
    clearTimeout(timer);
    remainingMs -= performance.now() - activeSince;
    if (remainingMs <= 0) {
      deadlinePauseDepth = 0;
      deadline.abort();
    }
    signal.throwIfAborted();
  }
  function resumeDeadline(): void {
    if (deadlinePauseDepth === 0) return;
    deadlinePauseDepth -= 1;
    if (deadlinePauseDepth > 0 || signal.aborted) return;
    activeSince = performance.now();
    timer = setTimeout(() => deadline.abort(), remainingMs);
  }
  const hookInjectionTracker = options.hookScope?.hookInjectionTracker
    ?? options.hookInjectionTracker
    ?? new HookInjectionTracker();
  // 子 Agent 沿用父级的 Hook 观测回调；主 Agent 直接使用调用方传入的回调。
  const onHookEvent = options.hookScope?.onHookEvent ?? options.onHookEvent;
  // 子 Agent 的 stdin 沿用父会话标识；主 Agent 省略 agent_id/agent_type。
  const hookSessionId = options.hookScope?.sessionId ?? options.sessionId;
  const hookTranscriptPath = options.hookScope?.transcriptPath ?? options.transcriptPath;
  const subagentHookFields = options.hookScope === undefined
    ? {}
    : { agent_id: options.hookScope.agentId, agent_type: options.hookScope.agentType };
  // 委派工具沿用同一份父会话范围；子 Agent 不能再委派，因此只对主 Agent 生效。
  const parentHookScope: ParentHookScope | undefined = hookSessionId === undefined || hookTranscriptPath === undefined
    ? undefined
    : {
      sessionId: hookSessionId,
      transcriptPath: hookTranscriptPath,
      hookInjectionTracker,
      ...(onHookEvent === undefined ? {} : { onHookEvent }),
    };
  // 成功工具调用的 PostToolUse 结果先按调用标识暂存，下一次 prepareStep 再注入。
  const pendingToolFeedback = new Map<string, HookEventResult>();
  const observations = new AgentObservations(options.tracing);
  const registry = new ToolRegistry({
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
    ...(options.onToolCallStart ? { beforeTool: options.onToolCallStart } : {}),
    preToolUse: async (call, toolSignal) => {
      if (config.hooks === undefined || config.disableAllHooks
        || hookSessionId === undefined || hookTranscriptPath === undefined) return undefined;
      // Hook 是同步策略计算：暂停整轮时限，避免慢 Hook 被对话超时误杀；finally 保证恢复。
      try {
        pauseDeadline();
        const hookInput: PreToolUseHookInput = {
          ...hookInputBase('PreToolUse', hookSessionId, hookTranscriptPath, config),
          ...subagentHookFields,
          tool_name: call.toolName,
          tool_input: call.input,
          tool_use_id: call.callId,
        };
        let result: Awaited<ReturnType<typeof runHookEvent>>;
        try {
          result = await runHookEvent(config.hooks, 'PreToolUse', hookInput, {
            cwd: config.workspace,
            env: process.env,
            signal: toolSignal ?? signal,
            ...(onHookEvent === undefined ? {} : { onHookEvent }),
          });
        } catch {
          process.stderr.write('[hook] PreToolUse: 执行失败（已忽略，不影响工具）\n');
          return undefined;
        }
        // 改写候选按工具注册的 inputSchema 校验；失败的运行仅作为非阻断错误提示。
        const evaluation = await evaluatePreToolUse(result, call.validateInput);
        for (const run of evaluation.runs) {
          const message = describeHookRun(run);
          if (message !== undefined) process.stderr.write(`${message}\n`);
        }
        return toolPreToolUseDecision(evaluation);
      } finally {
        resumeDeadline();
      }
    },
    postToolUse: async (call, toolSignal) => {
      if (config.hooks === undefined || config.disableAllHooks
        || hookSessionId === undefined || hookTranscriptPath === undefined) return;
      // 与 PreToolUse 一样，Hook 执行期间暂停整轮时限；反馈不参与工具结果构造。
      try {
        pauseDeadline();
        const hookInput: PostToolUseHookInput = {
          ...hookInputBase('PostToolUse', hookSessionId, hookTranscriptPath, config),
          ...subagentHookFields,
          tool_name: call.toolName,
          tool_input: call.input,
          tool_response: call.response,
          tool_use_id: call.callId,
        };
        let result: HookEventResult;
        try {
          result = await runHookEvent(config.hooks, 'PostToolUse', hookInput, {
            cwd: config.workspace,
            env: process.env,
            signal: toolSignal ?? signal,
            ...(onHookEvent === undefined ? {} : { onHookEvent }),
          });
        } catch {
          process.stderr.write('[hook] PostToolUse: 执行失败（已忽略，不影响工具）\n');
          return;
        }
        for (const run of result.runs) {
          const message = describeHookRun(run);
          if (message !== undefined) process.stderr.write(`${message}\n`);
        }
        if (result.runs.length > 0) pendingToolFeedback.set(call.callId, result);
      } finally {
        resumeDeadline();
      }
    },
    postToolUseFailure: async (call, toolSignal) => {
      if (config.hooks === undefined || config.disableAllHooks
        || hookSessionId === undefined || hookTranscriptPath === undefined) return;
      // 只有 execute 抛错会走到这里；反馈与 PostToolUse 共用工具结果后的注入位置。
      try {
        pauseDeadline();
        const hookInput: PostToolUseFailureHookInput = {
          ...hookInputBase('PostToolUseFailure', hookSessionId, hookTranscriptPath, config),
          ...subagentHookFields,
          tool_name: call.toolName,
          tool_input: call.input,
          error: call.error,
          error_code: call.errorCode,
          tool_use_id: call.callId,
        };
        let result: HookEventResult;
        try {
          result = await runHookEvent(config.hooks, 'PostToolUseFailure', hookInput, {
            cwd: config.workspace,
            env: process.env,
            signal: toolSignal ?? signal,
            ...(onHookEvent === undefined ? {} : { onHookEvent }),
          });
        } catch {
          process.stderr.write('[hook] PostToolUseFailure: 执行失败（已忽略，不影响工具）\n');
          return;
        }
        for (const run of result.runs) {
          const message = describeHookRun(run);
          if (message !== undefined) process.stderr.write(`${message}\n`);
        }
        if (result.runs.length > 0) pendingToolFeedback.set(call.callId, result);
      } finally {
        resumeDeadline();
      }
    },
    approve: async (call) => {
      signal.throwIfAborted();
      // 每个调用进入审批前读取当前模式；切换前已开始的等待继续使用其原有路径。
      const approval = resolveApproval(config, options.approvalMode, options.approvalControl, options.humanApprovalControl);
      try {
        return await observations.traceApproval(call, (tracing) =>
          approveToolCall(approval.config, call, signal, approval.control, { pause: pauseDeadline, resume: resumeDeadline }, preparedHistory, tracing));
      } catch (error) {
        if (!signal.aborted) {
          frameworkError = error instanceof AgentError ? error : new AgentError('APPROVAL_ERROR', '工具审批故障，已停止本轮。');
          frameworkAbort.abort(frameworkError);
        }
        throw error;
      }
    },
  });
  const fileBaselines = options.fileBaselines ?? new Map<string, WorkspaceFileSnapshot>();
  registerBuiltInTools(registry, {
    config,
    probe,
    allowAgent: !options.generalPurposeSubagent,
    ...(options.approvalControl === undefined ? {} : { approvalControl: options.approvalControl }),
    ...(options.humanApprovalControl === undefined ? {} : { humanApprovalControl: options.humanApprovalControl }),
    ...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode }),
    ...(options.backgroundTasks === undefined ? {} : { backgroundTasks: options.backgroundTasks }),
    fileWriteCallbacks: {
      ...(options.onBeforeWrite === undefined ? {} : { onBeforeWrite: options.onBeforeWrite }),
      ...(options.onCheckpointError === undefined ? {} : { onCheckpointError: options.onCheckpointError }),
    },
    fileBaselines,
    bashOperations,
    ...(options.onFileRead ? { onFileRead: options.onFileRead } : {}),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(parentHookScope === undefined ? {} : { hookScope: parentHookScope }),
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
  });
  let closeMCP: (() => Promise<void>) | undefined;
  try {
    closeMCP = await registerRemoteMCP(config, registry, signal);
    const model = wrapLanguageModel({
      model: provider.chat(options.modelOverride ?? config.model),
      middleware: {
        wrapStream: async ({ doStream }) => {
          signal.throwIfAborted();
          const result = await doStream();
          return {
            ...result,
            stream: result.stream.pipeThrough(new TransformStream({
              transform(part, controller) {
                if (part.type === 'error') {
                  frameworkError = modelStreamError(part.error);
                  frameworkAbort.abort(frameworkError);
                  controller.error(frameworkError);
                  return;
                }
                controller.enqueue(part);
              },
            })),
          };
        },
      },
    });
    const instructions = buildInstructions(config, options);
    const tools = registry.tools();
    let preparedResponseCount = 0;
    const summaries: RunResult['summaries'] = [];
    // 本运行内已生成的 Skill 注入；注入消息随 SDK 的步进消息延续到后续请求。
    const injectedSkillCalls = new Set<string>();
    const skillInjections: SkillInjection[] = [];
    let skillBodies = { ...options.skillBodies };
    let summaryCoverageBase = options.summaryCoverageBase ?? 0;
    let restoredCoverageBase = options.summaryRestoredBase ?? 0;
    let hasSummary = summaryCoverageBase > 0;
    const agent = new ToolLoopAgent({
      model,
      instructions,
      maxOutputTokens: (config.context ?? DEFAULT_CONTEXT).answerReserveTokens,
      tools,
      // SDK 的工作池负责并发上限；registry 按声明执行独占屏障与队首调度。
      toolCallConcurrency: MAX_TOOL_CALL_CONCURRENCY,
      stopWhen: isStepCount(stepLimit),
      onError: ({ error }) => {
        if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) return;
        frameworkError ??= modelStreamError(error);
        frameworkAbort.abort(frameworkError);
      },
      // 步骤在产生结果前失败时不会被 onLanguageModelCallEnd 覆盖，需显式结束对应 generation。
      onStepError: ({ callId, error }) => observations.failModelCall(callId, error),
      onAbort: () => observations.abortPending(),
      onLanguageModelCallStart: (event) => observations.startModelCall(event),
      onLanguageModelCallEnd: (event) => observations.endModelCall(event),
      onToolExecutionStart: (event) => observations.startTool(event),
      onToolExecutionEnd: (event) => observations.endTool(event),
      // Avoid automatic retries hiding auth failures or extending the deadline.
      maxRetries: 0,
      prepareStep: async ({ stepNumber, messages, responseMessages }) => {
        signal.throwIfAborted();
        // 手动压缩在工具结果写入历史之后、本次主模型请求之前执行；不重置步骤额度或执行时限。
        const forceCompaction = options.consumeCompactionRequest?.() ?? false;
        // 只扫描本轮响应消息；历史中的旧 Skill 调用已在历史里带有注入消息。
        const injections = options.skills === undefined
          ? []
          : collectSkillInjections(options.skills, responseMessages, injectedSkillCalls);
        if (injections.length > 0) {
          skillInjections.push(...injections);
          skillBodies = { ...skillBodies, ...Object.fromEntries(injections.map(({ name, body }) => [name, body])) };
        }
        // 工具反馈与 Skill 正文都排在工具结果之后，并作为本轮消息延续到后续步骤。
        // 工具反馈按工具结果的到达顺序注入，再按配置顺序排列同一事件的多个 Hook。
        const toolFeedback = takeToolFeedbackMessages(messages, pendingToolFeedback, hookInjectionTracker);
        const extraMessages = [...toolFeedback, ...injections.map(({ message }) => message)];
        const stepMessages = extraMessages.length === 0
          ? messages
          : [...messages, ...extraMessages];
        // 压缩恢复顺序包含本运行内新的加载，使同轮加载的正文也参与恢复。
        const restore = options.skills === undefined
          ? undefined
          : { catalogue: options.skills, recentLoads: appendRecentSkillLoads(options.recentSkillLoads ?? [], skillInjections.map(({ name }) => name)), bodies: skillBodies };
        preparedHistory = await prepareConversation(config, instructions, stepMessages, tools, signal, async (summary) => {
          // 优先使用持久化层按实际 transcript 计算的覆盖边界，避免依赖摘要或附件占用的消息数量。
          let saved: { coversThrough: number } | void = undefined;
          if (options.onCompaction) {
            try {
              saved = await options.onCompaction({
                effectiveHistory: summary.compacted,
                summary: { text: summary.text, restoredMessages: summary.restoredMessages },
              });
            } catch {
              signal.throwIfAborted();
              throw new AgentError('PROVIDER_ERROR', '压缩检查点保存失败，已停止本轮；压缩前的有效历史保持不变。');
            }
          }
          // 被覆盖的有效历史包含上一份摘要槽位及其恢复的正文，二者都不在 transcript 中。
          const coveredMessages = summary.coveredMessages - (hasSummary ? 1 + restoredCoverageBase : 0);
          const coversThrough = saved?.coversThrough ?? summaryCoverageBase + coveredMessages;
          const entry = summary.restoredMessages > 0
            ? { text: summary.text, coversThrough, restoredMessages: summary.restoredMessages }
            : { text: summary.text, coversThrough };
          summaries.push(entry);
          summaryCoverageBase = coversThrough;
          restoredCoverageBase = summary.restoredMessages;
          hasSummary = true;
        }, options.transcriptPath, {
          force: forceCompaction,
          ...(options.getRecentFiles ? { recentFiles: options.getRecentFiles() } : {}),
          ...(options.getTaskStatuses ? { getTaskStatuses: options.getTaskStatuses } : {}),
          ...(restore === undefined ? {} : { restore }),
          ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
        });
        preparedHistory = [...preparedHistory];
        preparedResponseCount = responseMessages.length;
        signal.throwIfAborted();
        return {
          messages: preparedHistory,
          ...(options.smokeTool ? { toolChoice: stepNumber === 0
            ? { type: 'tool' as const, toolName: 'read_file' as const }
            : 'none' as const } : {}),
        };
      },
    });

    signal.throwIfAborted();
    const inputMessages: ModelMessage[] = [
      ...(options.smokeTool ? [] : options.history ?? []),
      ...(options.smokeTool
        ? [{
          role: 'user' as const,
          content: `调用 read_file 读取 ${smokeProbePath}，然后在最终回答中逐字写出文件内容。`,
        }]
        : prompt === undefined
          ? []
          : [{ role: 'user' as const, content: prompt }]),
      // UserPromptSubmit 上下文必须排在用户消息之后，模型才能把它看作对本次提交的补充资料。
      ...(options.smokeTool ? [] : options.promptContext ?? []),
    ];
    const result = await agent.stream({
      messages: inputMessages,
      abortSignal: signal,
      experimental_transform: () => new TransformStream({
        transform(part, controller) {
          if (part.type !== 'tool-error') {
            controller.enqueue(part);
            return;
          }
          const rejection = registry.reject(part.toolCallId, part.toolName, part.error);
          if (!rejection) {
            frameworkError ??= new AgentError('PROVIDER_ERROR', '工具执行发生不可恢复错误，已终止当前对话轮次。');
            frameworkAbort.abort(frameworkError);
            controller.error(frameworkError);
            return;
          }
          controller.enqueue({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: rejection,
          } as unknown as typeof part);
        },
      }),
      onStepFinish: async ({ toolCalls, toolResults, content }) => {
        if (signal.aborted) return;
        for (const call of toolCalls) options.onToolCall?.(call.toolName);
        // This callback is awaited by the SDK before it starts the next model request.
        const callIds = toolCalls.map(({ toolCallId }) => toolCallId);
        const resultIds = toolResults.map(({ toolCallId }) => toolCallId);
        if (new Set(callIds).size !== callIds.length || callIds.some((id) => !id.trim())
          || resultIds.length !== callIds.length || new Set(resultIds).size !== resultIds.length
          || callIds.some((id) => !resultIds.includes(id))) {
          pairingError = new AgentError('PROVIDER_ERROR', '工具调用与结果无法一一配对，已终止当前对话轮次。');
          pairingAbort.abort(pairingError);
        }
        await options.onStepMessages?.(content);
      },
    });
    for await (const chunk of result.textStream) await options.onText?.(chunk);
    const [steps, responseMessages, text, finishReason, totalUsage] = await Promise.all([
      result.steps,
      result.responseMessages,
      result.text,
      result.finishReason,
      result.totalUsage,
    ]);
    signal.throwIfAborted();
    const toolResults = steps.flatMap((step) => step.toolResults);
    const toolSmokePassed = toolResults.some((item) => {
      if (item.toolName !== 'read_file') return false;
      const envelope = z.object({
        is_error: z.literal(false),
        output: z.object({ content: z.literal(probe) }),
      }).safeParse(item.output);
      return envelope.success;
    }) && text.includes(probe);

    if (options.smokeTool && !toolSmokePassed) {
      throw new AgentError('TOOL_COMPATIBILITY_ERROR', '工具冒烟失败：没有完成工具执行与结果回传，请检查模型和 provider 兼容性。');
    }
    if (steps.length >= stepLimit && steps.at(-1)?.toolCalls.length) {
      throw new AgentError('STEP_LIMIT', `已达到 ${stepLimit} 步上限，任务尚未生成最终回答。`);
    }
    if (finishReason !== 'stop' || !text.trim()) {
      throw new AgentError('PROVIDER_ERROR', '模型没有返回完整回答，请检查输出限制、服务策略或模型兼容性。');
    }
    return {
      text,
      responseMessages,
      roundMessages: insertSkillInjections(responseMessages, skillInjections),
      skillLoads: appendRecentSkillLoads([], skillInjections.map(({ name }) => name)),
      skillBodies: Object.fromEntries(skillInjections.map(({ name, body }) => [name, body])),
      // 最后一次请求的历史已包含此前工具往返，只追加该请求之后的新响应。
      effectiveHistory: [...preparedHistory, ...responseMessages.slice(preparedResponseCount)],
      summaries,
      steps: steps.length,
      toolCalls: steps.reduce((count, step) => count + step.toolCalls.length, 0),
      finishReason,
      usage: {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
      },
      toolSmokePassed: options.smokeTool && toolSmokePassed,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof AgentError ? reason : new AgentError('CANCELLED', '请求已取消。');
    }
    if (deadline.signal.aborted) {
      throw new AgentError('TIMEOUT', `请求超过 ${config.timeoutMs}ms，已终止。`);
    }
    if (pairingError) throw pairingError;
    if (frameworkError) throw frameworkError;
    throw error;
  } finally {
    clearTimeout(timer);
    await closeMCP?.();
    await Promise.allSettled(bashOperations);
    if (options.smokeTool) await unlink(join(config.workspace, smokeProbePath)).catch(() => undefined);
  }
}
