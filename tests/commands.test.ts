import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry, findCommand } from '../src/cli/commands.js';
import type { PromptCommandRecord } from '../src/cli/commands.js';
import { tempDir } from './helpers/temp-dir.js';

describe('命令记录', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await tempDir('qhy-command-'); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('按注册顺序比较规范名称、显示名称与别名，先注册者优先', async () => {
    const registry = new CommandRegistry();
    const first = vi.fn(() => ({ exit: false }));
    const duplicate = vi.fn(() => ({ exit: false }));
    const conflict = vi.fn(() => ({ exit: false }));
    await registry.register({ name: 'first', displayName: 'First', aliases: ['shared'], type: 'local', execute: first });
    await registry.register({ name: 'second', displayName: 'Second', aliases: ['second-alias'], type: 'local', execute: duplicate });
    await registry.register({ name: 'shared', displayName: 'Shared', aliases: [], type: 'local', execute: conflict });

    expect(registry.find('first')).toMatchObject({ name: 'first', displayName: 'First' });
    expect(registry.find('First')).toMatchObject({ name: 'first', displayName: 'First' });
    expect(registry.find('shared')).toMatchObject({ name: 'first', displayName: 'First' });
    expect(registry.find('second-alias')).toMatchObject({ name: 'second', displayName: 'Second' });
    expect(registry.find('missing')).toBeUndefined();
  });

  it('同名的后注册命令不会覆盖先注册的命令', async () => {
    const registry = new CommandRegistry();
    await registry.register({ name: 'duplicate', type: 'local', execute: () => undefined });
    await registry.register({ name: 'duplicate', type: 'local', execute: () => undefined });

    expect(registry.find('duplicate')).toMatchObject({ name: 'duplicate' });
    expect(registry.list().filter(({ name }) => name === 'duplicate')).toHaveLength(2);
  });

  it('显示名称缺省回退为规范名称，别名缺省为空', async () => {
    const registry = new CommandRegistry();
    await registry.register({ name: 'plain', type: 'local', execute: () => undefined });

    expect(registry.find('plain')).toMatchObject({ name: 'plain', displayName: 'plain', aliases: [] });
  });

  it('prompt 命令在注册时读入正文，来源文件变化不影响已注册内容', async () => {
    const source = join(cwd, 'skill.md');
    await writeFile(source, '注册时的正文');
    const registry = new CommandRegistry();
    await registry.register({ name: 'skill', displayName: 'Skill', type: 'prompt', source });

    await writeFile(source, '修改后的正文');
    const command = registry.find('Skill');
    if (command?.type !== 'prompt') throw new Error('未找到 prompt 命令');
    expect(command.getPromptForCommand()).toBe('注册时的正文');
    expect(registry.find('skill')).toBe(command);
  });

  it('可直接注册已构造的命令记录', async () => {
    const registry = new CommandRegistry();
    const record: PromptCommandRecord = {
      name: 'skill', displayName: 'Skill', aliases: ['alias'], type: 'prompt', getPromptForCommand: () => '正文',
    };
    await registry.register(record);

    expect(registry.find('alias')).toBe(record);
    expect(findCommand(registry.list(), 'skill')).toBe(record);
  });

  it('本地命令执行本地方式，不产生 prompt 正文', async () => {
    const registry = new CommandRegistry();
    const execute = vi.fn(() => ({ exit: true }));
    await registry.register({ name: 'local', type: 'local', execute });

    const command = registry.find('local');
    if (command?.type !== 'local') throw new Error('未找到本地命令');
    expect('getPromptForCommand' in command).toBe(false);
    expect(await command.execute()).toEqual({ exit: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});