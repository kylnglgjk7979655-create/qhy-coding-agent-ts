import { z } from 'zod';
import { DEFAULT_SANDBOX } from '../../services/settings/config.js';
import { cleanupSandboxPlan, createSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../../services/sandbox/sandbox-platform.js';
import { prepareBashInput, verifyBashWorkingDirectory } from './host-bash.js';
import { runPlannedBash } from './sandbox-bash.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerBashTool(registry: ToolRegistry, { config, bashOperations }: BuiltInToolContext): void {
  registry.register({
    name: 'Bash',
    description: '使用独立宿主 Bash 执行命令，继承 CLI 环境；cwd 仅约束启动目录，不提供操作系统隔离。',
    inputSchema: z.strictObject({ command: z.string().refine((value) => value.trim().length > 0), cwd: z.string().min(1).optional() }),
    // 计划在审批前生成，使人工审批与模型审批都能看到执行模式与不可用说明；执行层只消费同一份计划。
    prepare: async (input) => {
      const prepared = await prepareBashInput(config.workspace, input);
      const sandbox = config.permissions?.sandbox ?? DEFAULT_SANDBOX;
      const plan = await createSandboxPlan({
        config: sandbox,
        workspace: config.workspace,
        input: { command: prepared.input.command },
        // 关闭沙箱时无需启动探测子进程；计划首先返回 disabled。
        platform: sandbox.enabled ? await probeSandboxPlatform() : { seatbelt: false },
        env: process.env,
      });
      return {
        input: { ...prepared.input, plan },
        details: {
          ...prepared.details,
          ...(plan.notice === undefined ? {} : { sandboxNotice: plan.notice }),
        },
        // 审批拒绝或执行前失败时由 registry 回收本次调用的临时目录。
        cleanup: () => cleanupSandboxPlan(plan),
      };
    },
    execute: async ({ command, cwd, requestedCwd, approvedCwd, plan }, execution) => {
      await verifyBashWorkingDirectory(config.workspace, requestedCwd, approvedCwd);
      const operation = runPlannedBash(plan, command, cwd ?? config.workspace, execution.abortSignal, config.bash?.timeoutMs);
      bashOperations.add(operation);
      void operation.finally(() => bashOperations.delete(operation)).catch(() => undefined);
      return operation;
    },
  });
}
