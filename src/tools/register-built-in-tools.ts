import type { ResolvedConfig } from '../services/settings/config.js';
import type { WorkspaceFileBaselines, WorkspaceFileSnapshot } from './workspace-files.js';
import type { ToolRegistry } from './tool-registry.js';
import { registerRuntimeInfoTool } from './RuntimeInfoTool/RuntimeInfoTool.js';
import { registerFileReadTool } from './FileReadTool/FileReadTool.js';
import { registerGlobTool } from './GlobTool/GlobTool.js';
import { registerGrepTool } from './GrepTool/GrepTool.js';
import { registerFileWriteTool } from './FileWriteTool/FileWriteTool.js';
import { registerBashTool } from './BashTool/BashTool.js';
import { registerAgentTool } from './AgentTool/AgentTool.js';
import type { ApprovalControl } from './tool-approval.js';
import type { BackgroundAgentTasks } from './AgentTool/background-agent-tasks.js';

export interface BuiltInToolContext {
  config: ResolvedConfig;
  probe: string;
  allowAgent?: boolean;
  approvalControl?: ApprovalControl;
  backgroundTasks?: BackgroundAgentTasks;
  fileBaselines?: WorkspaceFileBaselines;
  fileWriteCallbacks: {
    onBeforeWrite?: (snapshot: WorkspaceFileSnapshot) => Promise<void>;
    onCheckpointError?: (path: string) => void;
  };
  bashOperations: Set<Promise<unknown>>;
}

export function registerBuiltInTools(registry: ToolRegistry, context: BuiltInToolContext): void {
  registerRuntimeInfoTool(registry, context);
  registerFileReadTool(registry, context);
  registerGlobTool(registry, context);
  registerGrepTool(registry, context);
  registerFileWriteTool(registry, context);
  registerBashTool(registry, context);
  if (context.allowAgent !== false) registerAgentTool(registry, context.config, context.approvalControl, context.backgroundTasks);
}
