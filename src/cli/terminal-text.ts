/** 将持久化的 ISO 时间显示为北京时间（固定 UTC+8）的 YYYY-MM-DD HH:mm:ss。 */
export function formatBeijingTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  // 北京时间没有夏令时，直接平移后按 UTC 字段格式化，避免依赖进程时区。
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

export function visibleText(text: string): string {
  return text.replaceAll('\u001b', '␛').replace(/[\r\n]+/gu, ' ').replace(/[\u0000-\u001a\u001c-\u001f\u007f]/gu, '�');
}

/** 按终端显示宽度裁剪文本；preserveEnd 时保留首尾，适合路径和错误。 */
export function fitText(text: string, columns: number, preserveEnd = false): string {
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
  return /\p{Mark}/u.test(character) ? 0 : /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-﹯＀-｠￠-￦\u{1f300}-\u{1faff}]/u.test(character) ? 2 : 1;
}