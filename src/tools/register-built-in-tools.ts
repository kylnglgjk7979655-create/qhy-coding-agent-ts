import type { ResolvedConfig } from '../services/settings/config.js';
import type { WorkspaceFileSnapshot } from './workspace-files.js';
import type { ToolRegistry } from './tool-registry.js';
import { registerRuntimeInfoTool } from './RuntimeInfoTool/RuntimeInfoTool.js';
import { registerFileReadTool } from './FileReadTool/FileReadTool.js';
import { registerGlobTool } from './GlobTool/GlobTool.js';
import { registerGrepTool } from './GrepTool/GrepTool.js';
import { registerFileWriteTool } from './FileWriteTool/FileWriteTool.js';
import { registerBashTool } from './BashTool/BashTool.js';

export interface BuiltInToolContext {
  config: ResolvedConfig;
  probe: string;
  options: {
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
}
