import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type Key = { key: string; key_id: string; expected_updated_at: string };
type Payload = { key_id: string; expected_updated_at: string; encrypted_value: string };
const subscription = require('../.github/scripts/subscription.cjs') as {
  validateAuth: (auth: string) => string;
  assertFreshSnapshot: (updated: string, created: string) => void;
  publicKey: (args: { github: unknown; context: unknown }) => Promise<void>;
  restore: () => Promise<void>;
  seal: () => Promise<void>;
  sealAuth: (auth: string, key: Key) => Promise<Payload>;
  persist: (args: { github: unknown; context: unknown }) => Promise<void>;
};
const sodium = require('libsodium-wrappers') as {
  ready: Promise<void>;
  base64_variants: { ORIGINAL: number };
  crypto_box_keypair: () => { publicKey: Uint8Array; privateKey: Uint8Array };
  to_base64: (value: Uint8Array, variant: number) => string;
  from_base64: (value: string, variant: number) => Uint8Array;
  crypto_box_seal_open: (value: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array) => Uint8Array;
  to_string: (value: Uint8Array) => string;
};
const fixture = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } });

describe('临时 Runner 的订阅登录态持久化', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-auth-state-test-'));
    await sodium.ready;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['invalid-json', '{}', '{"auth_mode":"apikey"}', '{"auth_mode":"chatgptAuthTokens"}'])('拒绝不支持的认证格式：%s', (value) => {
    expect(() => subscription.validateAuth(value)).toThrow();
  });

  it('对已在排队期间被替换的 Secret 拒绝恢复旧快照', () => {
    expect(() => subscription.assertFreshSnapshot('2026-11-04T10:02:00Z', '2026-11-04T10:00:00Z')).toThrow('重新触发');
    expect(() => subscription.assertFreshSnapshot('2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z')).not.toThrow();
    expect(() => subscription.assertFreshSnapshot('bad-time', '2026-11-04T10:00:00Z')).toThrow();
  });

  it('恢复登录文件时限制文件权限，并强制使用 ChatGPT 认证', async () => {
    const authDir = join(directory, 'codex-home');
    vi.stubEnv('CODEX_HOME', authDir);
    vi.stubEnv('CODEX_AUTH_JSON', fixture);
    await subscription.restore();
    expect(await readFile(join(authDir, 'auth.json'), 'utf8')).toBe(fixture);
    expect((await stat(join(authDir, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(authDir, 'config.toml'), 'utf8')).toContain('forced_login_method = "chatgpt"');
  });

  it('只导出公钥加密后的内容，可用配套私钥准确解密', async () => {
    const pair = sodium.crypto_box_keypair();
    const key: Key = { key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL), key_id: 'key-1', expected_updated_at: '2026-11-04T10:00:00Z' };
    const payload = await subscription.sealAuth(fixture, key);
    expect(JSON.stringify(payload)).not.toContain('fixture-access');
    expect(JSON.stringify(payload)).not.toContain('fixture-refresh');
    expect(payload.key_id).toBe('key-1');
    const decoded = sodium.crypto_box_seal_open(sodium.from_base64(payload.encrypted_value, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey);
    expect(sodium.to_string(decoded)).toBe(fixture);
  });

  it.each([false, true])('恢复、运行、回存完整流程只在登录文件变化时更新 Secret：变化=%s', async (changed) => {
    const pair = sodium.crypto_box_keypair();
    const context = { repo: { owner: 'owner', repo: 'repo' } };
    let updatedAt = '2026-11-08T03:00:00Z';
    const update = vi.fn().mockImplementation(async () => { updatedAt = '2026-11-08T03:23:00Z'; });
    const github = { rest: { actions: {
      getRepoSecret: vi.fn().mockImplementation(async () => ({ data: { updated_at: updatedAt } })),
      getRepoPublicKey: vi.fn().mockResolvedValue({ data: {
        key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL), key_id: 'key-1',
      } }),
      createOrUpdateRepoSecret: update,
    } } };
    vi.stubEnv('RUNNER_TEMP', directory);
    vi.stubEnv('CODEX_HOME', join(directory, 'codex-home'));
    vi.stubEnv('CODEX_AUTH_JSON', fixture);
    vi.stubEnv('AUTH_STORE_CONFIGURED', 'true');
    vi.stubEnv('AUTH_JSON_CONFIGURED', 'true');
    vi.stubEnv('RUN_CREATED_AT', '2026-11-08T03:16:00Z');
    await subscription.publicKey({ github, context });
    await subscription.restore();
    const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new-access', refresh_token: 'new-refresh' } });
    if (changed) await writeFile(join(directory, 'codex-home/auth.json'), refreshed);
    await subscription.seal();
    await subscription.persist({ github, context });

    if (changed) {
      expect(update).toHaveBeenCalledTimes(1);
      const payload = update.mock.calls[0]![0] as Payload;
      const decoded = sodium.crypto_box_seal_open(sodium.from_base64(payload.encrypted_value, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey);
      expect(sodium.to_string(decoded)).toBe(refreshed);
      expect(() => subscription.assertFreshSnapshot(updatedAt, '2026-11-08T03:17:43Z')).toThrow('重新触发');
    } else {
      vi.stubEnv('RUN_CREATED_AT', '2026-11-08T03:17:43Z');
      await expect(subscription.publicKey({ github, context })).resolves.toBeUndefined();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('运行中发生凭据更新时停止写回；版本一致时只更新指定 Secret', async () => {
    const pair = sodium.crypto_box_keypair();
    const payload = await subscription.sealAuth(fixture, {
      key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL), key_id: 'key-1', expected_updated_at: '2026-11-04T10:00:00Z',
    });
    vi.stubEnv('RUNNER_TEMP', directory);
    await mkdir(join(directory, 'codex-auth-update'));
    await writeFile(join(directory, 'codex-auth-update/encrypted.json'), JSON.stringify(payload));
    const update = vi.fn();
    const metadata = vi.fn().mockResolvedValue({ data: { updated_at: '2026-11-04T10:01:00Z' } });
    const github = { rest: { actions: { getRepoSecret: metadata, createOrUpdateRepoSecret: update } } };
    const context = { repo: { owner: 'owner', repo: 'repo' } };
    await expect(subscription.persist({ github, context })).rejects.toThrow('停止覆盖');
    expect(update).not.toHaveBeenCalled();
    metadata.mockResolvedValue({ data: { updated_at: payload.expected_updated_at } });
    await subscription.persist({ github, context });
    expect(update).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', secret_name: 'CODEX_AUTH_JSON', key_id: 'key-1', encrypted_value: payload.encrypted_value });
  });
});
