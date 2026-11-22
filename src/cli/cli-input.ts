import { createInterface, emitKeypressEvents } from 'node:readline';
import type { ApprovalControl } from '../tools/tool-approval.js';
import type { ToolApprovalRequest } from '../tools/tool-registry.js';
import type { BackgroundAgentTaskNotification } from '../tools/AgentTool/background-agent-tasks.js';
import { approvalOptionsFor, SessionApprovals } from './approval-policy.js';
import type { ApprovalOption } from './approval-policy.js';
import { fitText } from './terminal-text.js';

export type CliWorkItem = { type: 'user'; text: string } | { type: 'notification'; conversationId: string; notification: BackgroundAgentTaskNotification } | { type: 'compact' };

/**
 * 判定独立 Esc 前等待后续字节的窗口，同时作为 readline 的 escapeCodeTimeout。
 * 真实终端的转义序列（方向键等）通常与 ESC 同批或紧邻到达；readline 默认的 500ms
 * 会让 Esc 之后的第一个输入字符被当成 Alt 组合键吞掉，因此这里同步收紧。
 */
const ESCAPE_SEQUENCE_GRACE_MS = 30;
// 从 Esc 按下的时刻起，等 readline 结束判定再重新显示提示，确保提示出现后输入不再被吞。
const ESCAPE_INPUT_SETTLE_MS = 100;
// 原始输入阶段已处理的独立 Esc，readline 仍会补发一次 keypress；登记在此时间窗内的按下事件，
// 供审批菜单与选择器忽略迟到事件，避免它被算到后续轮次。
const ESCAPE_KEYPRESS_DELIVERY_MS = 600;

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
  private busy: 'turn' | 'compact' | undefined;
  /** 每次进入忙碌工作（轮次、通知轮次或压缩）递增，用于把 Esc 归属到按键按下时的轮次。 */
  private roundId = 0;
  private escapeId = 0;
  private pendingEscape: { id: number; roundId: number; pressedAt: number; overlay: boolean; timer: NodeJS.Timeout } | undefined;
  /** 已在原始输入阶段处理的独立 Esc 按下事件，用于忽略 readline 迟到补发的 keypress。 */
  private readonly handledEscapes: Array<{ id: number; pressedAt: number }> = [];
  private settleInputUntil = 0;
  private promptTimer: NodeJS.Timeout | undefined;
  private readonly cancelRequest: () => void;

  constructor(
    private readonly signal: AbortSignal,
    cancel: () => void,
    private readonly humanTimeoutMs: number,
    /** 即时处理的本地命令；返回 true 表示该行已被消费，不作为对话或审批答复。 */
    private readonly localLineHandler?: (line: string) => boolean,
  ) {
    this.cancelRequest = cancel;
    this.input = createInterface({
      input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY, signal,
      escapeCodeTimeout: ESCAPE_SEQUENCE_GRACE_MS,
    });
    this.input.on('SIGINT', cancel);
    // 直接从原始输入识别独立 Esc：readline 会缓存约 500ms 才发出 keypress，
    // 若按键时所在轮次在这段时间内结束，迟到的 keypress 会错误取消已排队的下一轮，
    // 并让尚未启动的工具获得执行机会。按键归属以原始输入到达时的轮次为准。
    if (process.stdin.isTTY) {
      process.stdin.on('data', this.onRawInput);
      // 登记之后的迟到 keypress 若无人消费，就此清除；审批菜单与选择器注册的处理器在其后运行。
      process.stdin.on('keypress', this.onEscapeKeypress);
    }
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
      process.stdin.off('data', this.onRawInput);
      process.stdin.off('keypress', this.onEscapeKeypress);
      if (this.pendingEscape) clearTimeout(this.pendingEscape.timer);
      this.pendingEscape = undefined;
      if (this.promptTimer) clearTimeout(this.promptTimer);
      this.promptTimer = undefined;
      this.confirmation?.close();
      this.confirmation = undefined;
      this.selector?.();
      for (const approval of [...this.approvals.values()]) approval.finish('deny', '拒绝本次（输入关闭）');
      this.wakeNext?.();
      this.wakeNext = undefined;
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
        else if (key.name === 'escape') {
          // 忽略属于先前轮次的迟到 Esc，避免刚打开的选择器被旧按键取消。
          if (this.takeHandledEscape()) return;
          finish(undefined);
        }
        else if (key.ctrl && key.name === 'c') finish(undefined);
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

  /** 刚处理过独立 Esc 时稍等 readline 结束按键判定再显示提示，避免提示出现后首字符被吞。 */
  prompt(): void {
    if (this.closed) return;
    const delay = this.settleInputUntil - Date.now();
    if (delay <= 0) {
      if (this.promptTimer) clearTimeout(this.promptTimer);
      this.promptTimer = undefined;
      this.input.prompt();
      return;
    }
    if (this.promptTimer) return;
    this.promptTimer = setTimeout(() => {
      this.promptTimer = undefined;
      // 已排队的工作可能在这段等待内启动；忙碌期间不显示提示。
      if (!this.closed && !this.busy) this.input.prompt();
    }, delay);
  }
  /**
   * 主循环执行轮次或压缩期间不重新显示提示，避免打断流式输出或审批提示。
   * `turn` 期间 Esc 取消本轮（含轮次内触发的压缩）；单独的手动压缩只沿用 Ctrl+C 取消。
   */
  setBusy(value: boolean, work: 'turn' | 'compact' = 'turn'): void {
    if (value) {
      this.roundId += 1;
      // 新工作开始时取消上一轮延后的提示，避免它在新轮次输出中途出现。
      if (this.promptTimer) clearTimeout(this.promptTimer);
      this.promptTimer = undefined;
    }
    this.busy = value ? work : undefined;
  }
  close(): void { this.input.close(); }

  /** 观察原始终端输入，只用于判定独立 Esc；不消费数据，readline 仍照常处理行编辑与朝向键。 */
  private readonly onRawInput = (chunk: Buffer | string): void => {
    const pending = this.pendingEscape;
    if (pending) {
      // 与 readline 一致：ESC 后继续到达的字节属于转义序列或 Alt 组合键，不是独立按键。
      clearTimeout(pending.timer);
      this.pendingEscape = undefined;
      // 若在按下时就登记了迟到事件（尚未确认），此时撤销，避免误吞之后真正的 Esc。
      if (!pending.overlay) this.forgetHandledEscape(pending.id);
      return;
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x1b) continue;
      if (index + 1 < bytes.length) {
        // ESC 与后续字节同批到达，例如方向键的 CSI/SS3 序列；跳过序列首字节即可。
        index += 1;
        continue;
      }
      const pressedAt = Date.now();
      // 按键时打开的审批菜单、选择器或信任确认自行消费 Esc，这里不登记也不取消。
      const overlay = Boolean(this.approvalMenu || this.approvals.size > 0 || this.selector || this.confirmation);
      const id = ++this.escapeId;
      this.pendingEscape = {
        id,
        roundId: this.roundId,
        pressedAt,
        overlay,
        timer: setTimeout(() => this.finishRawEscape(), ESCAPE_SEQUENCE_GRACE_MS),
      };
      // 在按下时刻登记，而不是等确认后：readline 补发的 keypress 可能与确认定时器同刻到达，
      // 先登记才能保证审批菜单和选择器不会收到属于先前轮次的事件。
      if (!overlay) this.handledEscapes.push({ id, pressedAt });
      return;
    }
  };

  /** 清除已到达且无人消费的登记；审批菜单与选择器会消费的按键保留给它们。 */
  private readonly onEscapeKeypress = (_character: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.name !== 'escape') return;
    if (this.approvalMenu || this.selector) return;
    this.takeHandledEscape();
  };

  private finishRawEscape(): void {
    const pending = this.pendingEscape;
    if (!pending) return;
    this.pendingEscape = undefined;
    if (pending.overlay) return;
    // 等 readline 结束 Esc 判定后再恢复提示，避免随后的第一个字符被当作 Alt 组合键。
    this.settleInputUntil = Math.max(this.settleInputUntil, pending.pressedAt + ESCAPE_INPUT_SETTLE_MS);
    // 只有按键时所在的轮次仍在执行才取消；旧轮次已结束时不得把取消顺延到已排队的下一轮。
    if (pending.roundId !== this.roundId) return;
    if (this.busy !== 'turn') return;
    this.cancelRequest();
  }

  private forgetHandledEscape(id: number): void {
    const index = this.handledEscapes.findIndex((event) => event.id === id);
    if (index >= 0) this.handledEscapes.splice(index, 1);
  }

  /** 读取并清理一个属于先前已消费按键的迟到 Esc；审批菜单与选择器在取消前调用。 */
  private takeHandledEscape(): boolean {
    const now = Date.now();
    while (this.handledEscapes.length > 0 && now - this.handledEscapes[0]!.pressedAt > ESCAPE_KEYPRESS_DELIVERY_MS) this.handledEscapes.shift();
    return this.handledEscapes.shift() !== undefined;
  }

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
        // 忽略属于先前轮次的迟到 Esc，避免刚打开的审批菜单被旧按键自动拒绝。
        if (this.takeHandledEscape()) return;
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
