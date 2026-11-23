import { approvalModeLabel } from '../tools/approval-mode.js';
import type { ApprovalMode } from '../services/settings/config.js';
import { fitText, terminalWidth, visibleText } from './terminal-text.js';

export interface InputFrameStatus {
  approvalMode: ApprovalMode;
  runningTasks: number;
}

const prompt = '> ';
const segments = new Intl.Segmenter();

/** 行编辑仍由 readline 处理。输入区只显示光标附近的内容，为底线和状态行腾出固定行数。 */
export class InputFrame {
  private visible = false;

  constructor(private readonly output: NodeJS.WriteStream) {}

  get isVisible(): boolean { return this.visible; }

  render(line: string, cursor: number, status: InputFrameStatus, clearScreen: boolean): void {
    const columns = this.output.columns || 80;
    const width = columns - 1;
    const prefix = fitText(prompt, width);
    const available = Math.max(0, width - terminalWidth(prefix));
    const input = inputViewport(line, cursor, available);
    // 用自动换行把整个输入区保持为一条逻辑行，使终端缩窗时把它与光标一起处理。
    const separator = `${'─'.repeat(width)} `;
    const beforeCursor = prefix + input.beforeCursor;
    const editor = `${beforeCursor}${input.afterCursor}\x1b[${columns}G `;
    const start = clearScreen ? '\x1b[H\x1b[2J' : this.visible ? '\r\x1b[1A\x1b[J' : '\r\x1b[J';
    // 回到输入行后重写光标前的文字，由终端决定 emoji 等字符的实际列宽。
    this.output.write(`${start}${separator}${editor}${separator}${statusLine(status, width)}\x1b[2A\r${beforeCursor}`);
    this.visible = true;
  }

  hide(): void {
    if (!this.visible) return;
    this.output.write('\r\x1b[1A\x1b[J');
    this.visible = false;
  }

  submit(line: string): void {
    this.hide();
    // 记录完整提交内容，包含编辑时滚出可见范围的部分。
    this.output.write(`${prompt}${visibleText(line)}\r\n`);
  }
}

function inputViewport(line: string, cursor: number, width: number): { beforeCursor: string; afterCursor: string } {
  const glyphs = Array.from(segments.segment(visibleText(line)), ({ segment, index }) => ({
    segment,
    index,
    width: terminalWidth(segment),
  }));
  const cursorIndex = glyphs.findIndex(({ index }) => index >= cursor);
  const end = cursorIndex === -1 ? glyphs.length : cursorIndex;
  let cursorColumn = 0;
  let start = end;
  while (start > 0 && cursorColumn + glyphs[start - 1]!.width <= width) {
    cursorColumn += glyphs[--start]!.width;
  }
  let visibleEnd = end;
  let visibleWidth = cursorColumn;
  while (visibleEnd < glyphs.length && visibleWidth + glyphs[visibleEnd]!.width <= width) {
    visibleWidth += glyphs[visibleEnd++]!.width;
  }
  return {
    beforeCursor: glyphs.slice(start, end).map(({ segment }) => segment).join(''),
    afterCursor: glyphs.slice(end, visibleEnd).map(({ segment }) => segment).join(''),
  };
}

function statusLine({ approvalMode, runningTasks }: InputFrameStatus, width: number): string {
  const task = runningTasks > 0 ? ` · 后台任务 ${runningTasks}` : '';
  const mode = `▸▸ 审批模式：${approvalModeLabel(approvalMode)}`;
  const candidates = [
    `${mode} · /permission-mode 切换${task}`,
    `${mode}${task}`,
    `${approvalMode}${task}`,
    runningTasks > 0 ? `${approvalMode} · 任务${runningTasks}` : approvalMode,
  ];
  return candidates.find((candidate) => terminalWidth(candidate) <= width) ?? fitText(approvalMode, width);
}
