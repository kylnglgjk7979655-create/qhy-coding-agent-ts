import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { tempDir } from './helpers/temp-dir.js';

const trustWarning = '已禁用全部 Hook';
const trustPrompt = '信任并启用这些 Hook';

function commandHook(command: string, timeoutMs?: number) {
  return { type: 'command' as const, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

describe('Hook 信任门禁与禁用开关', () => {
  let cwd: string;
  let home: string;
  const env = { TRUST_TEST_KEY: 'trust-test-key' };

  beforeEach(async () => {
    cwd = await tempDir('qhy-hooks-trust-');
    home = await tempDir('qhy-hooks-trust-home-');
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function writeSettings(settings: Record<string, unknown>): Promise<void> {
    await mkdir(join(cwd, '.agent'), { recursive: true });
    await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
      model: 'trust-fixture', apiKeyEnv: 'TRUST_TEST_KEY', ...settings,
    }));
  }

  function trustPath(): string {
    return join(home, '.qhy-coding-agents', 'trusted.json');
  }

  function hasTrustRecord(): Promise<boolean> {
    return access(trustPath()).then(() => true, () => false);
  }

  function run(input = '/exit\n', args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
    return startCLI({ cwd, userDir: home, input, args, env: { ...env, ...extraEnv } }).done;
  }

  function runPty(input: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return startCLI({ cwd, userDir: home, pty: true, input, env: { ...env, ...extraEnv } }).done;
  }

  describe('非交互场景', () => {
    it('未信任时在 stderr 给出禁用警告，且不写入信任记录', async () => {
      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('touch hook-ran')] }] } });

      const result = await run();

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(trustWarning);
      expect(result.stderr).toContain('--trust-hooks');
      expect(result.stdout).not.toContain(trustPrompt);
      expect(await hasTrustRecord()).toBe(false);
    });

    it.each([
      ['--trust-hooks', ['--trust-hooks'], {}],
      ['QHY_TRUST_HOOKS=1', [], { QHY_TRUST_HOOKS: '1' }],
    ])('%s 跳过确认并写入 0600 的信任记录', async (_label, args, extraEnv) => {
      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('echo trusted')] }] } });

      const result = await run('/exit\n', args, extraEnv);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain(trustWarning);
      expect(result.stdout).not.toContain(trustPrompt);
      const record = JSON.parse(await readFile(trustPath(), 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(record)).toMatch(/[0-9a-f]{64}/);
      if (process.platform !== 'win32') {
        expect((await stat(trustPath())).mode & 0o777).toBe(0o600);
        expect((await stat(join(home, '.qhy-coding-agents'))).mode & 0o077).toBe(0);
      }
      expect(await hasTrustRecord()).toBe(true);
    });

    it.each([
      ['disableAllHooks', { disableAllHooks: true }, []],
      ['--no-hooks', {}, ['--no-hooks']],
      ['--no-hooks 优先于 --trust-hooks', {}, ['--no-hooks', '--trust-hooks']],
    ])('%s 在未信任时不提示、不执行、不写记录', async (_label, settings, args) => {
      await writeSettings({
        hooks: { Stop: [{ hooks: [commandHook('touch disabled-hook-ran')] }] },
        ...settings,
      });

      const result = await run('/exit\n', args);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain(trustWarning);
      expect(result.stdout).not.toContain(trustPrompt);
      expect(await hasTrustRecord()).toBe(false);
    });

    it('修改无关 settings 不重新确认，修改 Hook 命令、matcher 或 timeoutMs 重新要求确认', async () => {
      await writeSettings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('echo first')] }] } });
      expect((await run('/exit\n', ['--trust-hooks'])).code).toBe(0);
      expect(await hasTrustRecord()).toBe(true);

      // 无关 settings 变化不影响信任判断。
      await writeSettings({
        model: 'trust-fixture', apiKeyEnv: 'TRUST_TEST_KEY', maxSteps: 21,
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('echo first')] }] },
      });
      const unrelated = await run();
      expect(unrelated.stderr).not.toContain(trustWarning);
      expect(unrelated.code).toBe(0);

      for (const hooks of [
        { PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('echo changed')] }] },
        { PreToolUse: [{ matcher: 'Read', hooks: [commandHook('echo first')] }] },
        { PreToolUse: [{ matcher: 'Bash', hooks: [commandHook('echo first', 1_000)] }] },
      ]) {
        await writeSettings({ hooks });
        const changed = await run();
        expect(changed.stderr).toContain(trustWarning);
        expect(changed.code).toBe(0);
      }
    });

    it('信任文件权限过宽时视为未信任，重新显式信任后恢复 0600', async () => {
      if (process.platform === 'win32') return;
      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('echo mode')] }] } });
      expect((await run('/exit\n', ['--trust-hooks'])).code).toBe(0);

      const { chmod } = await import('node:fs/promises');
      await chmod(trustPath(), 0o644);

      const untrusted = await run();
      expect(untrusted.stderr).toContain(trustWarning);

      const retrusted = await run('/exit\n', ['--trust-hooks']);
      expect(retrusted.stderr).not.toContain(trustWarning);
      expect((await stat(trustPath())).mode & 0o777).toBe(0o600);
    });

    it('忽略工作区内的信任文件', async () => {
      const workspaceTrust = {
        version: 1,
        trusted: { [cwd]: '0'.repeat(64) },
      };
      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('touch workspace-trust')] }] } });
      await writeFile(join(cwd, 'trusted.json'), JSON.stringify(workspaceTrust));
      await mkdir(join(cwd, '.agent'), { recursive: true });
      await writeFile(join(cwd, '.agent', 'trusted.json'), JSON.stringify(workspaceTrust));

      const result = await run();

      expect(result.stderr).toContain(trustWarning);
      expect(await hasTrustRecord()).toBe(false);
    });
  });

  describe('交互场景', () => {
    it.skipIf(process.platform === 'win32')('列出全部命令，同意后写入信任记录；再次启动不再询问', async () => {
      await writeSettings({
        hooks: {
          SessionStart: [{ hooks: [commandHook('echo 第一条命令')] }],
          Stop: [{ matcher: '*', hooks: [commandHook('echo 第二条命令')] }],
        },
      });

      const first = await runPty('yes\n/exit\n');

      expect(first.code).toBe(0);
      expect(first.stdout).toContain('echo 第一条命令');
      expect(first.stdout).toContain('echo 第二条命令');
      expect(first.stdout).toContain(trustPrompt);
      expect(first.stdout).not.toContain(trustWarning);
      const record = JSON.parse(await readFile(trustPath(), 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(record)).toMatch(/[0-9a-f]{64}/);
      expect((await stat(trustPath())).mode & 0o777).toBe(0o600);

      const second = await runPty('/exit\n');
      expect(second.code).toBe(0);
      expect(second.stdout).not.toContain(trustPrompt);
      expect(second.stdout).not.toContain(trustWarning);
    });

    it.skipIf(process.platform === 'win32')('拒绝后禁用全部 Hook 且不写入信任记录', async () => {
      await writeSettings({
        hooks: { Stop: [{ hooks: [commandHook('echo 不应执行')] }] },
      });

      const result = await runPty('no\n/exit\n');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('echo 不应执行');
      expect(result.stdout).toContain(trustPrompt);
      expect(result.stdout).toContain(trustWarning);
      expect(await hasTrustRecord()).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('Hook 配置变化后重新展示命令清单并要求确认', async () => {
      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('echo 旧命令')] }] } });
      expect((await runPty('yes\n/exit\n')).code).toBe(0);

      await writeSettings({ hooks: { Stop: [{ hooks: [commandHook('echo 新命令')] }] } });
      const changed = await runPty('no\n/exit\n');

      expect(changed.code).toBe(0);
      expect(changed.stdout).toContain('echo 新命令');
      expect(changed.stdout).not.toContain('echo 旧命令');
      expect(changed.stdout).toContain(trustPrompt);
    });
  });
});