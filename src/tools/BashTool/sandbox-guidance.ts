import type { SandboxConfig } from '../../services/settings/config.js';

/**
 * 生成 Bash 模型可见的沙箱说明。
 * 工具描述与系统提示共用同一段文字，避免两处对开关、边界与失败语义给出不同表述。
 */
export function bashSandboxGuidance(sandbox: SandboxConfig): string {
  if (!sandbox.enabled) {
    return '当前未启用沙箱（permissions.sandbox.enabled=false）：Bash 以宿主当前用户权限执行，继承 CLI 环境，没有操作系统隔离；disableSandbox 会被忽略。如需隔离，请在 settings 中启用 permissions.sandbox.enabled。';
  }
  const network = sandbox.networkAllow.length === 0
    ? 'networkAllow 为空，未启动代理，沙箱内没有网络；'
    : '仅 networkAllow 的主机与 networkPorts 的端口可经本机 HTTP 代理访问，代理启动失败时本次调用没有网络；';
  // 不可用策略来自配置，说明必须与计划实际返回的 open/closed 行为一致。
  const unavailable = sandbox.onUnavailable === 'closed'
    ? '沙箱不可用时按 onUnavailable="closed" 拒绝执行。'
    : '沙箱不可用时按 onUnavailable="open" 以宿主方式执行，工具结果会标注未隔离。';
  return [
    '沙箱已启用（permissions.sandbox.enabled=true）：Bash 默认在操作系统沙箱中执行，只保留最小环境变量、envPassthrough 与代理变量。',
    '读取默认允许，但拒绝内置敏感路径与 readDenyPaths，readAllowPaths 可在其后放行；',
    '写入默认拒绝，仅允许工作区、TMPDIR、本次调用临时目录与 writePaths，writeDenyPaths 与内置防篡改路径始终拒绝。',
    `网络默认禁止，${network}`,
    unavailable,
    '如确需在沙箱外执行，传入 disableSandbox: true 申请豁免；仅当沙箱可用且整条命令的每个简单命令都命中 bypassAllowedCommands 时才获准，否则仍在沙箱内执行。工具结果中的 sandboxed 与 notice 表示实际执行模式。',
  ].join('');
}
