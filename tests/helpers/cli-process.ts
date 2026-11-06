import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve('dist/cli.js');

export function startCLI(options: {
  cwd: string;
  conversationId: string;
  input: string;
  env: NodeJS.ProcessEnv;
}, onOutput?: (stdout: string) => void) {
  const child = spawn(process.execPath, [cli, '--conversation-id', options.conversationId], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onOutput?.(stdout); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(options.input);
  return { child, done };
}
