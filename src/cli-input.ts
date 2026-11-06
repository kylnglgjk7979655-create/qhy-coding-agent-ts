import { createInterface } from 'node:readline';
import type { ApprovalControl } from './tool-approval.js';

// 单一输入消费者将对话消息与正在等待的审批答复分开，已排队的消息不会变成批准。
export class CliInput {
  private readonly input;
  private readonly queued: string[] = [];
  private nextLine: ((line: string | undefined) => void) | undefined;
  private approval: { answer: (line: string) => void; close: () => void } | undefined;
  private closed = false;
  private sequence = 0;

  constructor(private readonly signal: AbortSignal, cancel: () => void, private readonly humanTimeoutMs: number) {
    this.input = createInterface({
      input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY, signal,
    });
    this.input.on('SIGINT', cancel);
    this.input.on('line', (line) => {
      if (this.approval) {
        this.approval.answer(line.trim());
      } else if (/^(approve|deny)(\s|$)/i.test(line.trim())) {
        process.stdout.write('\n当前没有对应的待审批调用，答复已忽略。\n');
      } else if (this.nextLine) {
        const deliver = this.nextLine;
        this.nextLine = undefined;
        deliver(line);
      } else {
        this.queued.push(line);
      }
    });
    this.input.on('close', () => {
      this.closed = true;
      this.approval?.close();
      this.nextLine?.(undefined);
      this.nextLine = undefined;
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      this.signal.throwIfAborted();
      const line = this.queued.length ? this.queued.shift()
        : this.closed ? undefined : await new Promise<string | undefined>((resolve) => { this.nextLine = resolve; });
      if (line === undefined) return;
      yield line;
    }
  }

  readonly approve: ApprovalControl = async (call, signal) => {
    signal.throwIfAborted();
    if (this.closed || !process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write('\n人工审批不可交互或输入已关闭，拒绝本次调用。\n');
      return 'deny';
    }
    const number = ++this.sequence;
    return new Promise((resolve) => {
      const finish = (decision: 'approve' | 'deny'): void => {
        signal.removeEventListener('abort', abort);
        this.approval = undefined;
        resolve(decision);
      };
      const abort = (): void => finish('deny');
      this.approval = {
        answer: (line) => {
          if (line === `approve ${number}`) finish('approve');
          else if (line === `deny ${number}`) finish('deny');
          else process.stdout.write(`\n答复无效，请输入 approve ${number} 或 deny ${number}。\n`);
        },
        close: () => finish('deny'),
      };
      signal.addEventListener('abort', abort, { once: true });
      process.stdout.write(`\n[人工审批 ${number}] ${call.toolName}（调用 ${call.callId}；最多等待 ${this.humanTimeoutMs}ms）\n${JSON.stringify(call.input, null, 2)}\n${call.details?.cwd ? `实际工作目录：${call.details.cwd}\n` : ''}批准请输入 approve ${number}，拒绝请输入 deny ${number}：\n`);
    });
  };

  prompt(): void { if (!this.closed) this.input.prompt(); }
  close(): void { this.input.close(); }
}
