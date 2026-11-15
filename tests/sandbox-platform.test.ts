import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 用可观察的 execFile 替身验证探测条件与进程内缓存；真实 Seatbelt 可用性由 macOS 集成测试覆盖。
const state = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: readonly string[] }>,
  fail: false,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    state.calls.push({ file, args });
    if (state.fail) callback(new Error('spawn sandbox-exec ENOENT'));
    else callback(null, '', '');
  },
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function loadProbe(): Promise<typeof import('../src/services/sandbox/sandbox-platform.js')> {
  return import('../src/services/sandbox/sandbox-platform.js');
}

beforeEach(() => {
  state.calls = [];
  state.fail = false;
  vi.resetModules();
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.resetModules();
});

describe('sandbox platform probe', () => {
  it('非 macOS 平台不启动 sandbox-exec，直接判定不可用', async () => {
    setPlatform('linux');
    const { probeSandboxPlatform } = await loadProbe();

    expect(await probeSandboxPlatform()).toEqual({ seatbelt: false });
    expect(state.calls).toEqual([]);
  });

  it('macOS 上以最小 profile 实际运行 sandbox-exec 后才判定可用', async () => {
    setPlatform('darwin');
    const { probeSandboxPlatform } = await loadProbe();

    expect(await probeSandboxPlatform()).toEqual({ seatbelt: true });
    expect(state.calls).toEqual([{
      file: 'sandbox-exec',
      args: ['-p', '(version 1) (allow default)', '/usr/bin/true'],
    }]);
  });

  it('sandbox-exec 缺失或最小 profile 运行失败时判定不可用', async () => {
    setPlatform('darwin');
    state.fail = true;
    const { probeSandboxPlatform } = await loadProbe();

    expect(await probeSandboxPlatform()).toEqual({ seatbelt: false });
    expect(state.calls).toHaveLength(1);
  });

  it('探测结果在进程内缓存，多次调用只自检一次', async () => {
    setPlatform('darwin');
    const { probeSandboxPlatform } = await loadProbe();

    const first = probeSandboxPlatform();
    const second = probeSandboxPlatform();

    expect(second).toBe(first);
    expect(await first).toEqual({ seatbelt: true });
    expect(await probeSandboxPlatform()).toEqual({ seatbelt: true });
    expect(state.calls).toHaveLength(1);
  });
});