import { readFileSync } from 'node:fs';

export type CommandType = 'local' | 'prompt';

export interface CommandDefinition {
  /** 规范名称，例如 /clear。 */
  readonly name: string;
  /** 显示名称；缺省回退为规范名称。 */
  readonly displayName?: string;
  /** 规范名称与显示名称之外可解析的别名。 */
  readonly aliases?: readonly string[];
}

export interface LocalCommandOutcome {
  /** 本地命令执行后是否结束 CLI 进程。 */
  readonly exit?: boolean;
}

export type LocalCommandExecution = () => LocalCommandOutcome | void | Promise<LocalCommandOutcome | void>;

export interface LocalCommandDefinition extends CommandDefinition {
  readonly type: 'local';
  /** 本地执行方式；不产生模型请求。 */
  readonly execute: LocalCommandExecution;
}

export interface PromptCommandDefinition extends CommandDefinition {
  readonly type: 'prompt';
  /** 正文来源；注册时读入内存，后续不重新读取文件。 */
  readonly source: string;
}

interface CommandRecordFields {
  readonly name: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
}

export interface LocalCommandRecord extends CommandRecordFields {
  readonly type: 'local';
  readonly execute: LocalCommandExecution;
}

export interface PromptCommandRecord extends CommandRecordFields {
  readonly type: 'prompt';
  /** 返回注册时读入并保存在命令记录中的正文。 */
  readonly getPromptForCommand: () => string;
}

export type CommandRecord = LocalCommandRecord | PromptCommandRecord;
export type CommandRegistration = LocalCommandDefinition | PromptCommandDefinition | CommandRecord;
/** Command 记录的别名，便于沿用领域词汇。 */
export type Command = CommandRecord;

function isPromptCommandRecord(value: CommandRegistration): value is PromptCommandRecord {
  return 'getPromptForCommand' in value;
}

function isLocalCommandRecord(value: CommandRegistration): value is LocalCommandRecord {
  return !('getPromptForCommand' in value)
    && 'displayName' in value
    && 'aliases' in value
    && 'execute' in value
    && !('source' in value);
}

// 命令列表按注册顺序查找；命中当前记录的规范名称、显示名称或别名后立即返回。
export function findCommand(commands: readonly CommandRecord[], input: string): CommandRecord | undefined {
  return commands.find((record) =>
    record.name === input || record.displayName === input || record.aliases.includes(input));
}

// 命令记录按注册顺序保存；查找统一在此处实现，避免调用方各自处理同名冲突。
export class CommandRegistry {
  private readonly records: CommandRecord[] = [];

  // 注册同步完成，调用方无需等待即可继续查找；正文也只在此处读入一次。
  async register(definition: CommandRegistration): Promise<void> {
    if (isPromptCommandRecord(definition) || isLocalCommandRecord(definition)) {
      this.records.push(definition);
      return;
    }
    const fields = {
      name: definition.name,
      displayName: definition.displayName ?? definition.name,
      aliases: [...(definition.aliases ?? [])],
    };
    if (definition.type === 'local') {
      this.records.push({ ...fields, type: 'local', execute: definition.execute });
      return;
    }
    // 注册时读取正文；之后来源文件变化不再影响该命令记录。
    const body = readFileSync(definition.source, 'utf8');
    this.records.push({ ...fields, type: 'prompt', getPromptForCommand: () => body });
  }

  find(input: string): CommandRecord | undefined {
    return findCommand(this.records, input);
  }

  list(): readonly CommandRecord[] {
    return [...this.records];
  }
}