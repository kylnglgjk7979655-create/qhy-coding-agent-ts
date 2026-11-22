import type { ApprovalMode, ResolvedConfig } from '../services/settings/config.js';
import type { WorkspaceFileBaselines, WorkspaceFileSnapshot } from './workspace-files.js';
import type { ToolRegistry } from './tool-registry.js';
import { registerRuntimeInfoTool } from './RuntimeInfoTool/RuntimeInfoTool.js';
import { registerSkillTool } from './SkillTool/SkillTool.js';
import { registerFileReadTool } from './FileReadTool/FileReadTool.js';
import { registerGlobTool } from './GlobTool/GlobTool.js';
import { registerGrepTool } from './GrepTool/GrepTool.js';
import { registerFileWriteTool } from './FileWriteTool/FileWriteTool.js';
import { registerEditTool } from './EditTool/EditTool.js';
import { registerTodoWriteTool } from './TodoWriteTool/TodoWriteTool.js';
import { registerWebFetchTool } from './WebFetchTool/WebFetchTool.js';
import { registerWebSearchTool } from './WebSearchTool/WebSearchTool.js';
import { registerBashTool } from './BashTool/BashTool.js';
import { registerAgentTool } from './AgentTool/AgentTool.js';
import type { ApprovalControl } from './tool-approval.js';
import type { BackgroundAgentTasks } from './AgentTool/background-agent-tasks.js';
import type { SkillCatalogue } from '../services/skills/skill-registry.js';
import type { ParentHookScope } from '../services/hooks/hook-scope.js';
import type { TracingScope } from '../services/observability/langfuse.js';

export interface BuiltInToolContext {
  config: ResolvedConfig;
  probe: string;
  allowAgent?: boolean;
  allowWorkspaceExternalRead?: boolean;
  approvalControl?: ApprovalControl;
  /** CLI 人工审批控制；子 Agent 在当前模式为 default 或 plan 时使用。 */
  humanApprovalControl?: ApprovalControl;
  /** 当前进程的审批模式，供子 Agent 与主 Agent 使用同一运行时状态。 */
  approvalMode?: () => ApprovalMode;
  backgroundTasks?: BackgroundAgentTasks;
  fileBaselines?: WorkspaceFileBaselines;
/** 成功读取工作区文件后回调规范目标路径，供会话记录最近读取顺序；失败读取不触发。 */
  onFileRead?: (target: string) => void;
  /** 主 Agent 与子 Agent 共享的 Skill 清单。 */
  skills?: SkillCatalogue;
  /** 主会话的工具 Hook 范围；委派工具据此让子 Agent 沿用父会话标识。 */
  hookScope?: ParentHookScope;
  /** 当前运行的跟踪 scope；子 Agent 工具据此创建独立 span。 */
  tracing?: TracingScope;
  fileWriteCallbacks: {
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
  };
  bashOperations: Set<Promise<unknown>>;
}

export function registerBuiltInTools(registry: ToolRegistry, context: BuiltInToolContext): void {
  registerRuntimeInfoTool(registry, context);
  if (context.skills !== undefined) registerSkillTool(registry, context.skills);
  registerFileReadTool(registry, context);
  registerGlobTool(registry, context);
  registerGrepTool(registry, context);
  registerFileWriteTool(registry, context);
  registerEditTool(registry, context);
  registerTodoWriteTool(registry);
  registerWebFetchTool(registry);
  registerWebSearchTool(registry, context);
  registerBashTool(registry, context);
  if (context.allowAgent !== false) {
    registerAgentTool(registry, context);
  }
}
