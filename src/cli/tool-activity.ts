import { fitText, visibleText } from './terminal-text.js';

export type ToolActivityStatus = 'started' | 'succeeded' | 'failed' | 'rejected';

export interface ToolActivityStream {
  write(chunk: string): void;
  isTTY?: boolean;
  columns?: number;
}

const statusLabels: Record<ToolActivityStatus, string> = {
  started: '运行中',
  succeeded: '成功',
  failed: '失败',
  rejected: '拒绝',
};

const summaryLimit = 72;

/**
 * 从完整参数中选出适合常驻终端一行的摘要。
 * 文件内容、MCP 密钥等不进入普通进度；完整参数只在人工审批界面展示。
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  const text = (key: string): string | undefined => typeof record[key] === 'string' ? record[key] : undefined;
  let summary: string | undefined;
  switch (toolName) {
    case 'Bash':
      summary = text('command');
      break;
    case 'read_file':
    case 'write_file':
      summary = text('path');
      break;
    case 'glob':
      summary = [text('pattern'), text('path') === undefined ? undefined : `path=${text('path')}`].filter(Boolean).join(', ');
      break;
    case 'grep':
      summary = [
        text('pattern'),
        text('glob') === undefined ? undefined : `glob=${text('glob')}`,
        text('path') === undefined ? undefined : `path=${text('path')}`,
      ].filter(Boolean).join(', ');
      break;
    case 'agent':
      summary = text('description');
      break;
    case 'skill':
      summary = text('name');
      break;
    default:
      // 未知工具与 MCP 参数可能包含凭据，只显示参数数量。
      summary = Object.keys(record).length > 0 ? `${Object.keys(record).length} 个参数` : '';
      break;
  }
  if (summary === undefined || summary.length === 0) return '';
  const compact = visibleText(summary).replace(/\s+/gu, ' ').trim();
  return compact.length <= summaryLimit ? compact : `${compact.slice(0, summaryLimit - 1)}…`;
}

export function formatToolActivityLine(
  toolName: string,
  input: unknown,
  status: ToolActivityStatus,
  columns = 80,
): string {
  const summary = summarizeToolInput(toolName, input);
  const label = summary ? `${toolName}(${summary})` : toolName;
  const suffix = ` · ${statusLabels[status]}`;
  // 状态始终保留，只裁剪工具名和参数，窄终端也能分辨运行、成功和拒绝。
  const available = Math.max(8, columns - 1 - Array.from(suffix).length);
  return `${fitText(`● ${label}`, available)}${suffix}`;
}

/**
 * 交互终端把同一模型步的工具调用聚合成一个紧凑块，状态原地刷新；
 * 非交互管道由 CLI 保留原有逐行事件，便于日志和自动测试。
 */
export class ToolActivityRenderer {
  private readonly order: string[] = [];
  private readonly entries = new Map<string, { toolName: string; input: unknown; status: ToolActivityStatus }>();
  private renderedLines = 0;
  private open = false;

  constructor(private readonly stream: ToolActivityStream) {}

  get enabled(): boolean {
    return this.stream.isTTY === true;
  }

  start(callId: string, toolName: string, input: unknown): void {
    if (!this.enabled) return;
    this.openBlock();
    this.upsert(callId, toolName, input, 'started');
    this.redraw();
  }

  finish(callId: string, toolName: string, input: unknown, status: ToolActivityStatus): void {
    if (!this.enabled) return;
    this.openBlock();
    this.upsert(callId, toolName, input, status);
    this.redraw();
  }

  /** 模型开始输出或本步工具结果已写入时调用；保留最终状态并结束当前活动块。 */
  flush(): void {
    if (!this.enabled || !this.open) return;
    this.redraw();
    this.open = false;
    this.renderedLines = 0;
    this.order.length = 0;
    this.entries.clear();
  }

  private openBlock(): void {
    if (this.open) return;
    this.stream.write('\n');
    this.open = true;
    this.renderedLines = 0;
    this.order.length = 0;
    this.entries.clear();
  }

  private upsert(callId: string, toolName: string, input: unknown, status: ToolActivityStatus): void {
    const existing = this.entries.get(callId);
    if (existing) {
      existing.toolName = toolName;
      existing.input = input;
      existing.status = status;
      return;
    }
    this.order.push(callId);
    this.entries.set(callId, { toolName, input, status });
  }

  private redraw(): void {
    if (this.renderedLines > 0) this.stream.write('\x1b[1A\x1b[2K'.repeat(this.renderedLines));
    const columns = Math.max(20, this.stream.columns !== undefined && this.stream.columns > 0 ? this.stream.columns : 80);
    const lines = this.order.map((callId) => {
      const entry = this.entries.get(callId)!;
      return formatToolActivityLine(entry.toolName, entry.input, entry.status, columns);
    });
    this.stream.write(`${lines.join('\n')}\n`);
    this.renderedLines = lines.length;
  }
}