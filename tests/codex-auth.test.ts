import { describe, expect, it, vi } from 'vitest';
import { codexAuthEnvironment } from '../.sandcastle/codex-auth.js';

describe('Codex 订阅认证', () => {
  it('默认复用订阅登录，并在检查和启动时清除继承的 API Key', () => {
    const status = vi.fn().mockReturnValue('Logged in using ChatGPT');
    const environment = codexAuthEnvironment({ CODEX_API_KEY: 'api-secret', OPENAI_API_KEY: 'other-secret' }, status);
    expect(environment).toEqual({ CODEX_API_KEY: '', OPENAI_API_KEY: '' });
    expect(status).toHaveBeenCalledWith({ CODEX_API_KEY: '', OPENAI_API_KEY: '' });
  });

  it('拒绝将 API 登录误认成订阅登录', () => {
    expect(() => codexAuthEnvironment({}, () => 'Logged in using an API key')).toThrow('不是 ChatGPT');
  });

  it('检查登录失败时给出操作说明，不回显命令错误中的凭据', () => {
    expect(() => codexAuthEnvironment({}, () => { throw new Error('sensitive-token'); })).toThrow('codex login');
    expect(() => codexAuthEnvironment({}, () => { throw new Error('sensitive-token'); })).not.toThrow('sensitive-token');
  });

  it('只有明确指定 API 模式才传入 API Key，且无需订阅登录', () => {
    const status = vi.fn();
    expect(codexAuthEnvironment({ CODEX_AUTH_MODE: 'api-key', CODEX_API_KEY: 'api-secret' }, status))
      .toEqual({ CODEX_API_KEY: 'api-secret' });
    expect(status).not.toHaveBeenCalled();
  });

  it('错误认证模式不会自动回退到付费 API', () => {
    expect(() => codexAuthEnvironment({ CODEX_AUTH_MODE: 'typo', CODEX_API_KEY: 'api-secret' }, vi.fn())).toThrow('只支持');
    expect(() => codexAuthEnvironment({ CODEX_AUTH_MODE: 'api-key' }, vi.fn())).toThrow('需要 CODEX_API_KEY');
  });
});
