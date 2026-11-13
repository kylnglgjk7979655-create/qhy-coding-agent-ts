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
  // macOS 的 BSD script 不支持 -qefc，且不接受 Node 的 socket 类型 stdin；用 cat 转成普通管道。
  const [file, fileArgs] = options.pty
    ? process.platform === 'darwin'
      ? ['/bin/sh', ['-c', 'cat | script "$@"', 'cli-process', '-q', '/dev/null', '/bin/sh', '-c', command]]
      : ['script', ['-qefc', command, '/dev/null']]
    : [process.execPath, [cli, ...args]];
  const child = spawn(file, fileArgs, {
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
  // PTY 建立前写入的输入会丢失，先缓冲到提示符出现。
  const pending: string[] = [];
  let ready = !options.pty;
  let endRequested = false;
  const flush = (): void => {
    if (!ready) return;
    for (const chunk of pending.splice(0)) child.stdin.write(chunk);
    if (endRequested) child.stdin.end();
  };
  const markReady = (): void => {
    if (ready || !stdout.includes('> ')) return;
    ready = true;
    flush();
  };
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onOutput?.(stdout); markReady(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  if (options.input !== undefined) pending.push(options.input);
  endRequested ||= options.input !== undefined;
  flush();
  return {
    child,
    done,
    send(input: string) {
      pending.push(input);
      flush();
    },
    end(input?: string) {
      if (input !== undefined) pending.push(input);
      endRequested = true;
      flush();
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
