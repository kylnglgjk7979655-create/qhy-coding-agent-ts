import { createInterface, emitKeypressEvents } from 'node:readline';
import type { ApprovalControl } from './tool-approval.js';

// 单一输入消费者将对话消息与正在等待的审批答复分开，已排队的消息不会变成批准。
export class CliInput {
  private readonly input;
  private readonly queued: string[] = [];
  private nextLine: ((line: string | undefined) => void) | undefined;
  private approval: { answer: (line: string) => void; close: () => void } | undefined;
  private closed = false;
  private sequence = 0;
  private selector: (() => void) | undefined;

  constructor(private readonly signal: AbortSignal, cancel: () => void, private readonly humanTimeoutMs: number) {
    this.input = createInterface({
      input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY, signal,
    });
    this.input.on('SIGINT', cancel);
    this.input.on('line', (line) => {
      if (this.selector) {
        // Enter is consumed by the active keyboard chooser, never as a chat or approval answer.
      } else if (this.approval) {
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
      this.selector?.();
      this.approval?.close();
      this.nextLine?.(undefined);
      this.nextLine = undefined;
    });
  }

  async select<T>(title: string, choices: Array<{ label: string; detail: string; value: T }>): Promise<T | undefined> {
    if (this.closed || !process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write('此选择需要交互终端，已退出选择且未执行操作。\n');
      return undefined;
    }
    if (choices.length === 0) return undefined;
    emitKeypressEvents(process.stdin);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let selected = 0;
    let typed = '';
    return new Promise<T | undefined>((resolve) => {
      let finished = false;
      const render = (): void => {
        const columns = Math.max(20, process.stdout.columns || 80);
        const rows = Math.max(6, process.stdout.rows || 24);
        const visibleCount = Math.max(1, Math.floor((rows - 4) / 2));
        // Keep each choice to two terminal rows so the focused choice cannot scroll off-screen.
        const start = Math.min(Math.max(0, selected - visibleCount + 1), Math.max(0, choices.length - visibleCount));
        const end = Math.min(choices.length, start + visibleCount);
        process.stdout.write('\u001b[2J\u001b[H');
        process.stdout.write(`${fitText(title, columns)}\n${fitText(`使用 ↑/↓ 移动，回车选择，Esc 或输入 /cancel 取消。${typed ? ` ${typed}` : ''}`, columns)}\n\n`);
        for (let index = start; index < end; index += 1) {
          const choice = choices[index]!;
          process.stdout.write(`${index === selected ? '❯' : ' '} ${fitText(choice.label, columns - 2)}\n  ${fitText(choice.detail, columns - 2, true)}\n`);
        }
        process.stdout.write(`${selected + 1}/${choices.length}${start > 0 ? ' · ↑ 还有' : ''}${end < choices.length ? ' · ↓ 还有' : ''}\n`);
      };
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        stdin.off('keypress', onKeypress);
        process.stdout.off('resize', render);
        stdin.setRawMode(wasRaw);
        this.selector = undefined;
        renderDone();
        resolve(value);
      };
      const renderDone = (): void => {
        process.stdout.write('\u001b[2J\u001b[H');
      };
      const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.name === 'up' || character === 'k') selected = (selected + choices.length - 1) % choices.length;
        else if (key.name === 'down' || character === 'j') selected = (selected + 1) % choices.length;
        else if (key.name === 'return') {
          if (typed.trim() === '/cancel') finish(undefined);
          else finish(choices[selected]?.value);
        }
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(undefined);
        else if (key.name === 'backspace') typed = typed.slice(0, -1);
        else if (character && !key.ctrl && character.length === 1) typed += character;
        if (!finished) render();
      };
      this.selector = () => finish(undefined);
      stdin.on('keypress', onKeypress);
      process.stdout.on('resize', render);
      render();
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

function visibleText(text: string): string {
  return text.replaceAll('\u001b', '␛').replace(/[\r\n]+/gu, ' ').replace(/[\u0000-\u001a\u001c-\u001f\u007f]/gu, '�');
}

function fitText(text: string, columns: number, preserveEnd = false): string {
  const readable = visibleText(text);
  const characters = Array.from(readable);
  const widths = characters.map(characterWidth);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= columns) return readable;
  if (!preserveEnd) {
    let width = 0;
    let end = 0;
    while (end < characters.length && width + widths[end]! <= columns - 1) width += widths[end++]!;
    return `${characters.slice(0, end).join('')}…`;
  }
  let tailWidth = 0;
  let tailStart = characters.length;
  while (tailStart > 0 && tailWidth + widths[tailStart - 1]! <= Math.floor((columns - 1) / 2)) tailWidth += widths[--tailStart]!;
  let headWidth = 0;
  let headEnd = 0;
  const headLimit = columns - 1 - tailWidth;
  while (headEnd < tailStart && headWidth + widths[headEnd]! <= headLimit) headWidth += widths[headEnd++]!;
  return `${characters.slice(0, headEnd).join('')}…${characters.slice(tailStart).join('')}`;
}

function characterWidth(character: string): number {
  return /\p{Mark}/u.test(character) ? 0 : /[\u1100-\u115f\u2e80-\uA4cf\uAC00-\uD7a3\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1f300}-\u{1faff}]/u.test(character) ? 2 : 1;
}
