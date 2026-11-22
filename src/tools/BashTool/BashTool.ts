import { z } from 'zod';
import { DEFAULT_SANDBOX } from '../../services/settings/config.js';
import { cleanupSandboxPlan, createSandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import type { SandboxPlan } from '../../services/sandbox/sandbox-plan.js';
import { probeSandboxPlatform } from '../../services/sandbox/sandbox-platform.js';
import { startSandboxNetwork } from '../../services/sandbox/sandbox-network.js';
import type { SandboxNetwork } from '../../services/sandbox/sandbox-network.js';
import { prepareBashInput, verifyBashWorkingDirectory } from './host-bash.js';
import { bashSandboxGuidance } from './sandbox-guidance.js';
import { runPlannedBash, startPlannedBash } from './sandbox-bash.js';
import type { BuiltInToolContext } from '../register-built-in-tools.js';
import { ToolExecutionError } from '../tool-registry.js';
import type { ToolRegistry } from '../tool-registry.js';

export function registerBashTool(registry: ToolRegistry, context: BuiltInToolContext): void {
  const { config, bashOperations, bashJobs } = context;
  const sandbox = config.permissions?.sandbox ?? DEFAULT_SANDBOX;
  registry.register({
    name: 'Bash',
    description: `使用独立 shell 运行命令和项目测试；cwd 仅约束启动目录。${bashSandboxGuidance(sandbox)}`,
    inputSchema: z.strictObject({
      command: z.string().refine((value) => value.trim().length > 0),
      cwd: z.string().min(1).optional(),
      // 仅申请，不构成授权：是否获准完全由沙箱配置与整条命令的排除表匹配决定。
      disableSandbox: z.boolean().optional(),
      // 直接启动后台作业；省略或 false 时保持原有前台调用语义。
      run_in_background: z.boolean().optional(),
    }),
    // 计划在审批前生成，使人工审批与模型审批都能看到执行模式与不可用说明；执行层只消费同一份计划。
    prepare: async (input) => {
      const prepared = await prepareBashInput(config.workspace, input);
      // 关闭沙箱时无需启动探测子进程；计划首先返回 disabled。
      const platform = sandbox.enabled ? await probeSandboxPlatform() : { seatbelt: false };
      let network: SandboxNetwork | undefined;
      try {
        const plan = await createSandboxPlan({
          config: sandbox,
          workspace: config.workspace,
          input: {
            command: prepared.input.command,
            ...(prepared.input.disableSandbox === undefined ? {} : { disableSandbox: prepared.input.disableSandbox }),
          },
          platform,
          env: process.env,
          // 惰性启动代理：只有计划实际进入沙箱时才创建本机监听；豁免获准等宿主分支不启动代理。
          // 启动失败返回 undefined，计划将拒绝全部网络，不退回直连。
          proxyPort: async () => {
            network = await startSandboxNetwork(sandbox);
            return network?.port;
          },
        });
        // 作业接管后 sandbox 资源必须随进程组结束再清理，不能等 execute 返回就关闭代理。
        const ownership = { jobOwned: false };
        return {
          input: { ...prepared.input, plan, ...(network === undefined ? {} : { network }), ownership },
          details: {
            ...prepared.details,
            ...sandboxApprovalDetails(plan),
            ...(plan.notice === undefined ? {} : { sandboxNotice: plan.notice }),
          },
          permission: prepared.permission,
          // 审批拒绝或执行前失败时由 registry 回收本次调用的代理与临时目录；执行层已关闭时重复调用无副作用。
          cleanup: async () => {
            // 作业已接管时由执行句柄在进程组结束后清理，避免后台运行期间关闭代理或删除 profile 目录。
            if (ownership.jobOwned) return;
            try {
              await network?.close();
            } finally {
              await cleanupSandboxPlan(plan);
            }
          },
        };
      } catch (error) {
        await network?.close();
        throw error;
      }
    },
    execute: async (
      { command, cwd, requestedCwd, approvedCwd, plan, network, ownership, run_in_background },
      execution,
    ) => {
      await verifyBashWorkingDirectory(config.workspace, requestedCwd, approvedCwd);
      // 没有绑定会话的调用（例如子 Agent）不能管理后台作业，保留原有前台语义。
      if (bashJobs === undefined) {
        if (run_in_background === true) {
          throw new ToolExecutionError('当前调用没有绑定主会话，无法启动后台 Bash 作业。', undefined);
        }
        const operation = runPlannedBash(
          plan, command, cwd ?? config.workspace, execution.abortSignal, config.bash?.timeoutMs, network,
        );
        bashOperations.add(operation);
        void operation.finally(() => bashOperations.delete(operation)).catch(() => undefined);
        return operation;
      }
      execution.abortSignal?.throwIfAborted();
      const timeoutMs = config.bash?.timeoutMs ?? 30_000;
      // 进程不绑定轮次信号：切到后台后轮次结束或取消不能误杀仍在运行的作业；前台取消由作业层终止。
      const planned = await startPlannedBash(plan, command, cwd ?? config.workspace, network, { timeoutMs: null });
      ownership.jobOwned = true;
      const launch = { command, execution: planned, timeoutMs };
      if (run_in_background === true) return bashJobs.startBackground(launch);
      const operation = bashJobs.runForeground(launch, execution.abortSignal);
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
