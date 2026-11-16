import type { HookInjectionTracker } from './hook-engine.js';

/**
 * 主会话的工具 Hook 范围：子 Agent 的 stdin 沿用父对话的 session_id 与记录路径，
 * 并复用父级的 Hook 配置、信任判定结果和注入去重集合。
 */
export interface ParentHookScope {
  sessionId: string;
  transcriptPath: string;
  hookInjectionTracker?: HookInjectionTracker;
}

/** 子 Agent 在父会话范围上附加自身身份；主 Agent 的工具事件不写 agent_id/agent_type。 */
export interface SubagentHookScope extends ParentHookScope {
  agentId: string;
  agentType: string;
}