export interface BashCommandAnalysis {
  commands: string[];
  requiresApproval: boolean;
}

/** 只接受能逐条识别简单命令的 Bash 语法；不认识的复合语法按参数错误拒绝。 */
export function analyzeBashCommand(source: string): BashCommandAnalysis {
  const commands: string[] = [];
  let requiresApproval = false;

  const parse = (text: string, depth: number): void => {
    if (depth > 32) throw new Error('命令替换嵌套过深');
    let start = 0;
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let connectorPending = false;
    const flush = (end: number): void => {
      const command = text.slice(start, end).trim();
      if (command) {
        connectorPending = false;
        if (/^(?:if|then|elif|else|fi|for|while|until|case|esac|select|function|coproc|time|\{|\}|\(\(|\[\[|!)(?:\s|$)/u.test(command)) {
          throw new Error('不支持无法逐条检查的 Bash 控制结构');
        }
        commands.push(command);
      } else if (connectorPending) {
        throw new Error('复合命令缺少命令');
      }
    };

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (escaped) { escaped = false; continue; }
      if (character === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote === "'") { if (character === "'") quote = undefined; continue; }
      if (quote === '"') {
        if (character === '"') { quote = undefined; continue; }
        if (character === '$' && text[index + 1] === '(' && text[index + 2] !== '(') {
          const nested = findSubstitution(text, index + 1);
          parse(nested.body, depth + 1);
          index = nested.end;
        } else if (character === '`') {
          const nested = findBacktick(text, index + 1);
          parse(nested.body, depth + 1);
          index = nested.end;
        }
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character === '$' && text[index + 1] === '(') {
        if (text[index + 2] === '(') {
          index = parseArithmeticExpansion(text, index + 3, (nested) => parse(nested, depth + 1));
          continue;
        }
        const nested = findSubstitution(text, index + 1);
        parse(nested.body, depth + 1);
        index = nested.end;
        continue;
      }
      if (character === '`') {
        const nested = findBacktick(text, index + 1);
        parse(nested.body, depth + 1);
        index = nested.end;
        continue;
      }
      if ((character === '<' || character === '>') && text[index + 1] === '(') {
        requiresApproval = true;
        const nested = findSubstitution(text, index + 1);
        parse(nested.body, depth + 1);
        index = nested.end;
        continue;
      }
      if (character === '<' || character === '>') {
        requiresApproval = true;
        if (text[index + 1] === '<' && text[index + 2] === '<') throw new Error('不支持无法可靠解析的 here-document');
        if (text.slice(index + 1).trim() === '') throw new Error('重定向缺少目标');
        continue;
      }
      if (character === '&' && text[index + 1] === '>') {
        requiresApproval = true;
        index += 1;
        if (text[index + 1] === '>') index += 1;
        continue;
      }
      if (character === '&' && text[index - 1] === '>') continue;
      if (character === '(' || character === ')') throw new Error('不支持无法逐条检查的 Bash 分组');
      if (character === ';' || character === '\n' || character === '|' || character === '&') {
        const doubled = text[index + 1] === character;
        const pipeStderr = character === '|' && text[index + 1] === '&';
        if ((character === '|' || character === '&') && !text.slice(start, index).trim()) throw new Error('复合命令缺少命令');
        flush(index);
        if (character === '|' || character === '&') {
          if (character === '|' || (character === '&' && doubled)) connectorPending = true;
          if (pipeStderr) requiresApproval = true;
          if (doubled) index += 1;
          else if (pipeStderr) index += 1;
          if (character === '|' || (character === '&' && !doubled)) requiresApproval = true;
        }
        start = index + 1;
      }
    }
    if (quote !== undefined || escaped) throw new Error('引号或转义符未闭合');
    flush(text.length);
    if (connectorPending) throw new Error('复合命令缺少命令');
  };

  parse(source, 0);
  if (commands.length === 0) throw new Error('命令中没有可检查的简单命令');
  return { commands, requiresApproval };
}

/** 算术扩展也会执行其中的命令替换，必须纳入同一条命令权限检查。 */
function parseArithmeticExpansion(text: string, start: number, parseNested: (source: string) => void): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '$' && text[index + 1] === '(' && text[index + 2] !== '(') {
      const nested = findSubstitution(text, index + 1);
      parseNested(nested.body);
      index = nested.end;
      continue;
    }
    if (text[index] === '`') {
      const nested = findBacktick(text, index + 1);
      parseNested(nested.body);
      index = nested.end;
      continue;
    }
    if (text[index] === ')' && text[index + 1] === ')') return index + 1;
  }
  throw new Error('算术扩展未闭合');
}

function findSubstitution(text: string, openIndex: number): { body: string; end: number } {
  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = openIndex + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote === "'") { if (character === "'") quote = undefined; continue; }
    if (quote === '"') { if (character === '"') quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '$' && text[index + 1] === '(') { depth += 1; index += 1; continue; }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, index), end: index };
    }
  }
  throw new Error('命令替换未闭合');
}

function findBacktick(text: string, openIndex: number): { body: string; end: number } {
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '`') return { body: text.slice(openIndex, index), end: index };
  }
  throw new Error('命令替换未闭合');
}
