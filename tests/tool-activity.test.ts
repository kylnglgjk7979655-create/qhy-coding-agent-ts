import { describe, expect, it } from 'vitest';
import { formatToolActivityLine, summarizeToolInput, ToolActivityRenderer } from '../src/cli/tool-activity.js';

function capture(isTTY = true, columns = 100) {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write(chunk: string) { chunks.push(chunk); }, isTTY, columns },
  };
}

describe('工具参数摘要', () => {
  it('Bash 显示命令，文件工具只显示路径，不泄露内容', () => {
    expect(summarizeToolInput('Bash', { command: 'printf hello' })).toBe('printf hello');
    expect(summarizeToolInput('read_file', { path: 'note.txt' })).toBe('note.txt');
    expect(summarizeToolInput('write_file', { path: 'note.txt', content: 'TOP_SECRET_CONTENT' })).toBe('note.txt');
    expect(summarizeToolInput('write_file', { path: 'note.txt', content: 'TOP_SECRET_CONTENT' }))
      .not.toContain('TOP_SECRET_CONTENT');
  });

  it('控制字符折叠为可读单行并截断过长参数', () => {
    expect(summarizeToolInput('Bash', { command: 'printf a\nprintf b' })).toBe('printf a printf b');
    const long = summarizeToolInput('Bash', { command: 'x'.repeat(200) });
    expect(Array.from(long).length).toBeLessThanOrEqual(72);
    expect(long.endsWith('…')).toBe(true);
  });

  it('MCP 与未知工具只显示参数数量，不输出可能含凭据的值', () => {
    const summary = summarizeToolInput('mcp_fs_read', { path: 'a.txt', token: 'SECRET_TOKEN' });
    expect(summary).toBe('2 个参数');
    expect(summary).not.toContain('SECRET_TOKEN');
    expect(formatToolActivityLine('mcp_fs_read', { path: 'a.txt', token: 'SECRET_TOKEN' }, 'started'))
      .toBe('● mcp_fs_read(2 个参数) · 运行中');
  });
});

describe('交互工具活动块', () => {
  it('同一模型步的工具按行聚合，状态原地刷新并在步末保留最终状态', () => {
    const { chunks, stream } = capture();
    const renderer = new ToolActivityRenderer(stream);

    renderer.start('call-1', 'Bash', { command: 'echo hi' });
    renderer.start('call-2', 'read_file', { path: 'note.txt' });
    renderer.finish('call-1', 'Bash', { command: 'echo hi' }, 'succeeded');
    renderer.finish('call-2', 'read_file', { path: 'note.txt' }, 'succeeded');
    renderer.flush();

    const output = chunks.join('');
    expect(output).toContain('● Bash(echo hi) · 运行中');
    expect(output).toContain('● read_file(note.txt) · 运行中');
    expect(output).toContain('● Bash(echo hi) · 成功');
    expect(output).toContain('● read_file(note.txt) · 成功');
    expect(output).toContain('\x1b[1A\x1b[2K');
    expect(output).not.toContain('[工具]');
    // 同一屏幕块只保留两行；不会为每个开始/成功事件追加新行。
    const finalChunk = chunks.at(-1)!;
    expect(finalChunk.trimEnd().split('\n')).toEqual([
      '● Bash(echo hi) · 成功',
      '● read_file(note.txt) · 成功',
    ]);
  });

  it('步末结束后新工具重新开块，拒绝事件也能进入当前块', () => {
    const { chunks, stream } = capture();
    const renderer = new ToolActivityRenderer(stream);

    renderer.finish('rejected', 'write_file', { path: 'note.txt', content: 'secret' }, 'rejected');
    renderer.flush();
    renderer.start('next', 'runtimeInfo', {});
    renderer.finish('next', 'runtimeInfo', {}, 'succeeded');
    renderer.flush();

    const output = chunks.join('');
    expect(output).toContain('● write_file(note.txt) · 拒绝');
    expect(output).not.toContain('secret');
    expect(output).toContain('● runtimeInfo · 运行中');
    expect(output).toContain('● runtimeInfo · 成功');
  });

  it('非交互输出不写任何内容，由 CLI 保留原有逐行事件', () => {
    const { chunks, stream } = capture(false);
    const renderer = new ToolActivityRenderer(stream);

    renderer.start('call-1', 'Bash', { command: 'echo hi' });
    renderer.finish('call-1', 'Bash', { command: 'echo hi' }, 'succeeded');
    renderer.flush();

    expect(renderer.enabled).toBe(false);
    expect(chunks).toEqual([]);
  });
});