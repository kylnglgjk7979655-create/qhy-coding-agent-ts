import { z } from 'zod';
import { DEFAULT_SANDBOX } from '../../services/settings/config.js';
import { cleanupSandboxPlan, createSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../../services/sandbox/sandbox-platform.js';
import { prepareBashInput, verifyBashWorkingDirectory } from './host-bash.js';
import { runPlannedBash } from './sandbox-bash.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerBashTool(registry: ToolRegistry, { config, bashOperations }: BuiltInToolContext): void {
  registry.register({
    name: 'Bash',
    description: '使用独立宿主 Bash 执行命令，继承 CLI 环境；cwd 仅约束启动目录，不提供操作系统隔离。',
    inputSchema: z.strictObject({
      command: z.string().refine((value) => value.trim().length > 0),
      cwd: z.string().min(1).optional(),
      // 仅申请，不构成授权：是否获准完全由沙箱配置与整条命令的排除表匹配决定。
      disableSandbox: z.boolean().optional(),
    }),
    // 计划在审批前生成，使人工审批与模型审批都能看到执行模式与不可用说明；执行层只消费同一份计划。
    prepare: async (input) => {
      const prepared = await prepareBashInput(config.workspace, input);
      const sandbox = config.permissions?.sandbox ?? DEFAULT_SANDBOX;
      const plan = await createSandboxPlan({
        config: sandbox,
        workspace: config.workspace,
        input: {
          command: prepared.input.command,
          ...(prepared.input.disableSandbox === undefined ? {} : { disableSandbox: prepared.input.disableSandbox }),
        },
        // 关闭沙箱时无需启动探测子进程；计划首先返回 disabled。
        platform: sandbox.enabled ? await probeSandboxPlatform() : { seatbelt: false },
        env: process.env,
      });
      return {
        input: { ...prepared.input, plan },
        details: {
          ...prepared.details,
          ...sandboxApprovalDetails(plan),
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

/**
 * 审批展示只读取已生成的计划，不重新推导执行模式。
 * 沙箱关闭时的豁免申请按“忽略”呈现，避免用户误以为参数生效。
 */
function sandboxApprovalDetails(plan: SandboxPlan): Record<string, string> {
  return {
    sandboxExecution: plan.mode === 'sandbox' ? '沙箱内执行' : plan.mode === 'reject' ? '拒绝执行' : '沙箱外执行',
    sandboxBypass: bypassApprovalLabel(plan),
  };
}

function bypassApprovalLabel(plan: SandboxPlan): string {
  if (!plan.bypassRequested) return '未申请';
  if (plan.reason === 'disabled') return '已忽略（沙箱未启用）';
  if (plan.reason === 'bypass-approved') return '获准';
  if (plan.reason === 'bypass-denied') return '未获准';
  return '未适用（沙箱不可用）';
}
