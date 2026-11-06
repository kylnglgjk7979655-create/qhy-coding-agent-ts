import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { codex, type AgentProvider } from '@ai-hero/sandcastle';
import { withCodexDiagnostics } from './codex-diagnostics.js';

// Codex 的 turn.completed 用量是累计值；上下文大小来自该会话最后一次模型调用。
export async function runCodex<T>(model: string, env: Record<string, string>, execute: (agent: AgentProvider) => Promise<T>): Promise<T> {
  const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const provider = codex(model, { effort: 'high', captureSessions: false, env, sessionStorage: { hostSessionsDir: sessionsDir } });
  let sessionId: string | undefined;
  const diagnostics = withCodexDiagnostics(provider);
  const skillsRoot = join(process.env.AGENT_WORKSPACE || process.cwd(), '.agents', 'skills');
  let skills: string[];
  try {
    skills = (await readdir(skillsRoot, { recursive: true })).filter((file) => file.endsWith('SKILL.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    skills = [];
  }
  const disabledSkills = `skills.config=[${skills.map((file) => `{path=${JSON.stringify(join(skillsRoot, file))},enabled=false}`).join(',')}]`;
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const agent: AgentProvider = {
    ...diagnostics,
    buildPrintCommand(options) {
      const command = diagnostics.buildPrintCommand(options);
      return { ...command, command: `${command.command} -c ${shellQuote(disabledSkills)}` };
    },
    parseStreamLine(line) {
      const events = diagnostics.parseStreamLine(line);
      for (const event of events) if (event.type === 'session_id') sessionId = event.sessionId;
      return events;
    },
  };
  console.log(`Codex 模型：${model}`);
  try {
    return await execute(agent);
  } finally {
    let context: ReturnType<NonNullable<AgentProvider['parseSessionContextWindow']>>;
    try {
      const content = sessionId && await provider.sessionStorage?.readHostSession('', sessionId);
      context = content ? provider.parseSessionContextWindow?.(content) : undefined;
    } catch { context = undefined; }
    console.log(context
      ? `Codex 上下文：${context.tokens} tokens${context.limit ? ` / ${context.limit} tokens` : ''}（最后一次模型调用的输入）`
      : 'Codex 上下文：不可用（会话未提供上下文用量）');
  }
}
