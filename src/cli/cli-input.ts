import { clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import type { ApprovalControl } from '../tools/tool-approval.js';
import type { ToolApprovalRequest } from '../tools/tool-registry.js';
import type { BackgroundAgentTaskNotification } from '../tools/AgentTool/background-agent-tasks.js';
import { approvalModeLabel } from '../tools/approval-mode.js';
import type { ApprovalModeState } from '../tools/approval-mode.js';
import { approvalOptionsFor, SessionApprovals } from './approval-policy.js';
import type { ApprovalOption } from './approval-policy.js';
import { fitText } from './terminal-text.js';

export type CliWorkItem = { type: 'user'; text: string } | { type: 'notification'; conversationId: string; notification: BackgroundAgentTaskNotification } | { type: 'compact' };

interface PendingApproval {
  number: number;
  call: ToolApprovalRequest;
  answerText?: (line: string) => void;
  finish: (decision: 'approve' | 'deny', note?: string) => void;
}

interface ApprovalMenu {
  number: number;
  options: ApprovalOption[];
  selected: number;
  hasSelection: boolean;
  renderedLines: number;
  hint: string;
  wasRaw: boolean;
  onKeypress: (character: string, key: { name?: string; ctrl?: boolean }) => void;
}

// 单一输入消费者将对话消息与正在等待的审批答复分开，已排队的消息不会变成批准。
export class CliInput {
  private readonly input;
  private readonly queued: string[] = [];
  private wakeNext: (() => void) | undefined;
  private readonly notifications: Array<Extract<CliWorkItem, { type: 'notification' }>> = [];
  private readonly approvals = new Map<number, PendingApproval>();
  private readonly sessionApprovals = new SessionApprovals();
  private closed = false;
  private sequence = 0;
  private selector: (() => void) | undefined;
  private approvalMenu: ApprovalMenu | undefined;
  private confirmation: { answer: (line: string) => void; close: () => void } | undefined;
  private compactRequested = false;
  private busy = false;
  private readonly cancelRequest: () => void;

  constructor(
    private readonly signal: AbortSignal,
    cancel: () => void,
    private readonly humanTimeoutMs: number,
    /** 即时处理的本地命令；返回 true 表示该行已被消费，不作为对话或审批答复。 */
    private readonly localLineHandler?: (line: string) => boolean,
    /** 可选的进程级审批模式；提供时提示栏展示当前模式并响应 Shift+Tab。 */
    private readonly approvalMode?: ApprovalModeState,
  ) {
    this.cancelRequest = cancel;
    this.input = createInterface({
      input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY, signal,
    });
    this.setPromptText();
    if (process.stdin.isTTY) process.stdin.on('keypress', this.onModeKeypress);
    this.input.on('SIGINT', cancel);
    this.input.on('line', (line) => {
      if (this.confirmation) {
        // 信任确认答复优先于对话消息和审批答复，避免启动输入被当成一次用户请求。
        this.confirmation.answer(line);
      } else if (this.selector) {
        // Enter 由活动中的键盘选择器消费，不能变成聊天或审批答复。
      } else if (this.localLineHandler?.(line.trim())) {
        // 审批等待或轮次执行中也可切换模式；只有空闲时才重新显示输入提示。
        if (!this.busy && this.approvals.size === 0 && !this.closed && process.stdin.isTTY) this.prompt();
      } else if (this.approvalMenu) {
        // Enter 由活动中的审批菜单消费，不能变成聊天或审批答复。
      } else if (this.approvals.size > 0) {
        const match = /^(approve|deny)\s+(\d+)$/i.exec(line.trim());
        const approval = match ? this.approvals.get(Number(match[2])) : undefined;
        if (approval) approval.answerText?.(line.trim());
        else if (this.approvals.size === 1) this.approvals.values().next().value?.answerText?.(line.trim());
        else process.stdout.write(`\n有待审批调用，请按对应编号答复：${[...this.approvals.keys()].join('、')}。\n`);
      } else if (/^(approve|deny)(\s|$)/i.test(line.trim())) {
        process.stdout.write('\n当前没有对应的待审批调用，答复已忽略。\n');
      } else if (line.trim() === '/compact') {
        // 空闲时由主循环处理；执行中登记为待压缩请求，在工具结果写入后、下一次主模型请求前生效。
        this.compactRequested = true;
        process.stdout.write('\n已收到 /compact。\n');
        this.wakeNext?.();
      } else if (this.wakeNext) {
        this.queued.push(line);
        this.wakeNext();
      } else {
        this.queued.push(line);
      }
    });
    this.input.on('close', () => {
      this.closed = true;
      process.stdin.off('keypress', this.onModeKeypress);
      this.confirmation?.close();
      this.confirmation = undefined;
      this.selector?.();
      for (const approval of [...this.approvals.values()]) approval.finish('deny', '拒绝本次（输入关闭）');
      this.wakeNext?.();
      this.wakeNext = undefined;
    });
  }

  /** 提示栏只显示模式名称和语义；缺少模式状态时保持旧版裸提示符。 */
  private setPromptText(): void {
    this.input.setPrompt(this.approvalMode === undefined
      ? '> '
      : `[${approvalModeLabel(this.approvalMode.current())}] > `);
  }

  /** 交互终端的 Shift+Tab 在三个审批模式间循环，与 /permission-mode 共用同一进程状态。 */
  private readonly onModeKeypress = (_character: string, key: { name?: string; shift?: boolean }): void => {
    if (key.name !== 'tab' || key.shift !== true) return;
    if (this.approvalMode === undefined || this.closed
      || this.confirmation !== undefined || this.selector !== undefined || this.approvalMenu !== undefined) return;
    const next = this.approvalMode.cycle();
    // 有草稿时 readline 内部仍保留整行；先清掉已渲染的提示区，再输出模式提示并完整重绘草稿与光标。
    const restoreDraft = !this.busy && this.approvals.size === 0 && this.input.line !== '';
    if (restoreDraft) this.clearRenderedInput();
    process.stdout.write(`\n当前审批模式：${approvalModeLabel(next)}。\n`);
    if (restoreDraft) this.redrawInput();
    // 审批等待由菜单独占键盘；轮次执行中只更新状态，下一次提示符再显示新模式。
    else if (!this.busy && this.approvals.size === 0) this.prompt();
  };

  /** 清除 readline 已渲染的提示区；草稿可能跨行，需连同上方各行一起清除。 */
  private clearRenderedInput(): void {
    const input = this.input as unknown as { prevRows?: number };
    const rows = input.prevRows ?? 0;
    if (rows > 0) moveCursor(process.stdout, 0, -rows);
    cursorTo(process.stdout, 0);
    clearScreenDown(process.stdout);
  }

  /** 重绘提示符、完整草稿和光标位置；readline 的刷新方法负责跨行与宽字符的定位。 */
  private redrawInput(): void {
    this.setPromptText();
    const input = this.input as unknown as { _refreshLine?: () => void; prevRows?: number };
    // 提示区已经清除，重置行数避免刷新时错误地回退到模式提示行。
    input.prevRows = 0;
    if (typeof input._refreshLine === 'function') {
      input._refreshLine();
      return;
    }
    process.stdout.write(`${this.input.getPrompt()}${this.input.line}`);
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

  /** 首次遇到未信任 Hook 时请求确认；只有交互终端会展示，非交互调用一律视为拒绝。 */
  async confirmHookTrust(workspace: string, commands: string): Promise<boolean> {
    if (this.closed || !process.stdin.isTTY || !process.stdout.isTTY) return false;
    process.stdout.write(`\n[hook] 检测到未信任的 Hook 配置（工作区：${workspace}）。\n${commands}\n信任并启用这些 Hook 请输入 yes，其他输入将禁用本次运行的全部 Hook：\n> `);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (accepted: boolean): void => {
        if (finished) return;
        finished = true;
        this.confirmation = undefined;
        resolve(accepted);
      };
      this.confirmation = {
        answer: (line) => finish(/^(yes|y)$/i.test(line.trim())),
        close: () => finish(false),
      };
    });
  }

  enqueueNotification(conversationId: string, notification: BackgroundAgentTaskNotification): void {
    if (this.notifications.some(({ notification: queued }) => queued.taskId === notification.taskId)) return;
    this.notifications.push({ type: 'notification', conversationId, notification });
    this.wakeNext?.();
  }

  async nextWorkItem(conversationId: string): Promise<CliWorkItem | undefined> {
    while (true) {
      this.signal.throwIfAborted();
      if (this.compactRequested) {
        this.compactRequested = false;
        return { type: 'compact' };
      }
      const line = this.queued.shift();
      if (line !== undefined) return { type: 'user', text: line };
      const notificationIndex = this.notifications.findIndex((item) => item.conversationId === conversationId);
      if (notificationIndex >= 0) return this.notifications.splice(notificationIndex, 1)[0];
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => { this.wakeNext = resolve; });
      this.wakeNext = undefined;
    }
  }

  /** 供执行中的主模型循环取出待处理的手动压缩请求，取出后立即清除。 */
  consumeCompactRequest(): boolean {
    if (!this.compactRequested) return false;
    this.compactRequested = false;
    return true;
  }

  readonly approve: ApprovalControl = async (call, signal) => {
    signal.throwIfAborted();
    if (this.sessionApprovals.canSkipPrompt(call)) {
      process.stdout.write(`\n[人工审批] ${call.toolName} 已在本会话获准，跳过默认审批。\n`);
      return 'approve';
    }
    if (this.closed) {
      process.stdout.write('\n人工审批不可交互或输入已关闭，拒绝本次调用。\n');
      return 'deny';
    }
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const number = ++this.sequence;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: 'approve' | 'deny', note?: string): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        this.approvals.delete(number);
        if (this.approvalMenu?.number === number) this.closeApprovalMenu(note);
        resolve(decision);
        if (interactive) setImmediate(() => this.startApprovalMenu());
      };
      const abort = (): void => finish('deny', '拒绝本次（已取消）');
      const pending: PendingApproval = { number, call, finish };
      this.approvals.set(number, pending);
      signal.addEventListener('abort', abort, { once: true });
      if (interactive) {
        this.startApprovalMenu();
      } else {
        // 非交互场景保留文本审批协议，答复规则与旧版一致。
        pending.answerText = (line) => {
          if (line === `approve ${number}`) finish('approve');
          else if (line === `deny ${number}`) finish('deny');
          else process.stdout.write(`\n答复无效，请输入 approve ${number} 或 deny ${number}。\n`);
        };
        process.stdout.write(this.approvalPromptText(number, pending.call, `批准请输入 approve ${number}，拒绝请输入 deny ${number}：\n`));
      }
    });
  };

  prompt(): void {
    if (this.closed) return;
    this.setPromptText();
    this.input.prompt();
  }
  /** 主循环执行轮次或压缩期间不重新显示提示，避免打断流式输出或审批提示。 */
  setBusy(value: boolean): void { this.busy = value; }
  close(): void { this.input.close(); }

  private startApprovalMenu(): void {
    if (this.approvalMenu || this.closed || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const pending = this.approvals.values().next().value;
    if (!pending) return;
    const options = approvalOptionsFor(pending.call);
    const menu: ApprovalMenu = {
      number: pending.number,
      options,
      selected: 0,
      hasSelection: false,
      renderedLines: 0,
      hint: '',
      wasRaw: process.stdin.isRaw,
      onKeypress: () => undefined,
    };
    this.approvalMenu = menu;
    // 先接好键盘再打印提示，外面看到审批标题时输入不会落回行缓冲。
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    menu.onKeypress = (character, key) => {
      if (this.approvalMenu !== menu) return;
      const count = menu.options.length;
      if (key.name === 'up' || character === 'k') {
        menu.selected = (menu.selected + count - 1) % count;
        menu.hasSelection = true;
      } else if (key.name === 'down' || character === 'j') {
        menu.selected = (menu.selected + 1) % count;
        menu.hasSelection = true;
      } else if (character !== undefined && /^[1-9]$/u.test(character)) {
        const index = Number(character) - 1;
        if (index < count) {
          menu.selected = index;
          menu.hasSelection = true;
        }
      } else if (key.name === 'return' || key.name === 'enter') {
        if (!menu.hasSelection) {
          // 默认不确认，避免审批期间输入的其他文字被误当作批准。
          menu.hint = '请先按数字或 ↑/↓ 选择，再按回车确认。';
          this.renderApprovalOptions();
          return;
        }
        const option = menu.options[menu.selected]!;
        if (option.choice === 'always-tool') this.sessionApprovals.remember(pending.call.toolName);
        const decision = option.choice === 'deny-once' ? 'deny' : 'approve';
        const note = option.choice === 'always-tool'
          ? `已在本会话始终批准 ${pending.call.toolName}`
          : option.choice === 'approve-once' ? '已批准本次' : '已拒绝本次';
        pending.finish(decision, note);
        return;
      } else if (key.name === 'escape') {
        pending.finish('deny', '已拒绝本次');
        return;
      } else if (key.ctrl && key.name === 'c') {
        pending.finish('deny', '已拒绝本次');
        this.cancelRequest();
        return;
      } else if (key.ctrl && key.name === 'd') {
        // 原始模式下 Ctrl+D 不再产生 EOF，显式关闭输入以拒绝后续待审批调用。
        this.input.close();
        return;
      } else {
        // 未识别的按键不改变选择，也不重绘，避免审批期间输入的文字变成批准。
        return;
      }
      this.renderApprovalOptions();
    };
    process.stdin.on('keypress', menu.onKeypress);
    process.stdout.write(this.approvalPromptText(pending.number, pending.call, ''));
    this.renderApprovalOptions();
  }

  private renderApprovalOptions(): void {
    const menu = this.approvalMenu;
    if (!menu) return;
    const columns = Math.max(20, process.stdout.columns || 80);
    if (menu.renderedLines > 0) process.stdout.write('\x1b[1A\x1b[2K'.repeat(menu.renderedLines));
    const lines = menu.options.map((option, index) => {
      const pointer = index === menu.selected ? '❯' : ' ';
      return fitText(`${pointer} ${index + 1}. ${option.label}`, columns - 1);
    });
    lines.push(fitText(menu.hint || '使用 ↑/↓ 或数字键选择，回车确认，Esc 拒绝本次。', columns - 1));
    process.stdout.write(`${lines.join('\n')}\n`);
    menu.renderedLines = lines.length;
  }

  private closeApprovalMenu(note: string | undefined): void {
    const menu = this.approvalMenu;
    if (!menu) return;
    process.stdin.off('keypress', menu.onKeypress);
    try { process.stdin.setRawMode(menu.wasRaw); } catch { /* 输入已关闭时无法恢复模式。 */ }
    this.approvalMenu = undefined;
    const columns = Math.max(20, process.stdout.columns || 80);
    const rendered = menu.renderedLines;
    if (rendered > 0) process.stdout.write('\x1b[1A\x1b[2K'.repeat(rendered));
    process.stdout.write(`${fitText(`→ ${note ?? '已处理'}`, columns - 1)}\n\x1b[0J`);
  }

  private approvalPromptText(number: number, call: ToolApprovalRequest, suffix: string): string {
    const pending = this.approvals.size > 1 ? `；还有 ${this.approvals.size - 1} 项待审批` : '';
    const details = [
      call.details?.target ? `实际文件目标：${call.details.target}` : '',
      call.details?.cwd ? `实际工作目录：${call.details.cwd}` : '',
      call.details?.searchAsk ? `需审批的搜索范围：${call.details.searchAsk}` : '',
      call.details?.sandboxExecution ? `沙箱执行模式：${call.details.sandboxExecution}` : '',
      call.details?.sandboxBypass ? `豁免申请：${call.details.sandboxBypass}` : '',
      call.details?.sandboxNotice ? `沙箱状态：${call.details.sandboxNotice}` : '',
      call.hookPermission?.reason ? `Hook 审批说明：${call.hookPermission.reason}` : '',
    ].filter(Boolean).map((line) => `${line}\n`).join('');
    return `\n[人工审批 ${number}] ${call.toolName}（调用 ${call.callId}；最多等待 ${this.humanTimeoutMs}ms${pending}）\n${JSON.stringify(call.input, null, 2)}\n${details}${suffix}`;
  }
}
