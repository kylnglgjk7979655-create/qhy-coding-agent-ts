import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { authSlots, selectAuthSlot } = require('../.github/scripts/auth-slots.cjs');
afterEach(() => vi.unstubAllEnvs());

it('默认复用单份认证；多槽位只接受明确配置的独立 Secret', () => {
  expect(authSlots('')).toEqual(['CODEX_AUTH_JSON']);
  const slots = '["CODEX_AUTH_JSON_A","CODEX_AUTH_JSON_B"]';
  expect(selectAuthSlot(2, '', slots)).toBe('CODEX_AUTH_JSON_A');
  expect(selectAuthSlot(3, '', slots)).toBe('CODEX_AUTH_JSON_B');
  expect(selectAuthSlot(2, 'CODEX_AUTH_JSON_B', slots)).toBe('CODEX_AUTH_JSON_B');
  expect(() => selectAuthSlot(2, 'OTHER_SECRET', slots)).toThrow('未配置');
});

it.each(['[]', '{}', '["CODEX_AUTH_JSON_A","CODEX_AUTH_JSON_A"]', '["OTHER_SECRET"]', '[1]'])('拒绝错误槽位配置 %s', (value) => {
  expect(() => authSlots(value)).toThrow();
});
