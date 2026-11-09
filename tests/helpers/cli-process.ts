import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve('dist/cli.js');

export function startCLI(options: {
  cwd: string;
  conversationId?: string;
  args?: string[];
  input?: string;
  pty?: boolean;
  userDir?: string;
  env: NodeJS.ProcessEnv;
}, onOutput?: (stdout: string) => void) {
  const args = [...(options.conversationId === undefined ? [] : ['--conversation-id', options.conversationId]), ...(options.args ?? [])];
  const command = [process.execPath, cli, ...args].map(shellQuote).join(' ');
  const child = options.pty
    ? spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        HOME: options.userDir ?? options.cwd,
        USERPROFILE: options.userDir ?? options.cwd,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    : spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      HOME: options.userDir ?? options.cwd,
      USERPROFILE: options.userDir ?? options.cwd,
    },
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
  if (options.input !== undefined) child.stdin.end(options.input);
  return {
    child,
    done,
    send(input: string) {
      child.stdin.write(input);
    },
    end(input?: string) {
      child.stdin.end(input);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
