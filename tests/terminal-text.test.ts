import { describe, expect, it } from 'vitest';
import { formatBeijingTime } from '../src/cli/terminal-text.js';

describe('北京时间展示', () => {
  it('把 UTC ISO 时间换算为固定 UTC+8 的日期时间，并丢弃毫秒', () => {
    expect(formatBeijingTime('2026-11-17T14:50:19.739Z')).toBe('2026-11-17 22:50:19');
  });

  it('按绝对时间归一，带其他偏移的 ISO 也换算为北京时间', () => {
    expect(formatBeijingTime('2026-11-17T09:00:00+09:00')).toBe('2026-11-17 08:00:00');
  });

  it('跨日与跨年按北京时间进位', () => {
    expect(formatBeijingTime('2025-12-31T20:00:00Z')).toBe('2026-01-01 04:00:00');
  });

  it('无法解析的输入原样返回，不伪造时间', () => {
    expect(formatBeijingTime('not-a-time')).toBe('not-a-time');
    expect(formatBeijingTime('')).toBe('');
  });
});