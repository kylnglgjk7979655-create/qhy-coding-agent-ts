import { describe, expect, it, vi } from 'vitest';
import { codexAuthEnvironment, resolveCodexModel } from '../.sandcastle/codex-auth.js';

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

  it('错误认证模式不会自动回退到付费 API', () => {
    expect(() => codexAuthEnvironment({ CODEX_AUTH_MODE: 'typo', CODEX_API_KEY: 'api-secret' }, vi.fn())).toThrow('只支持');
    expect(() => codexAuthEnvironment({ CODEX_AUTH_MODE: 'api-key', CODEX_API_KEY: 'api-secret' }, vi.fn())).toThrow('只支持');
  });

  it('优先使用显式配置的模型名', () => {
    const listModels = vi.fn();
    expect(resolveCodexModel({ CODEX_MODEL: '  custom-model  ' }, listModels)).toBe('custom-model');
    expect(listModels).not.toHaveBeenCalled();
  });

  it('未配置模型时使用 codex debug models 的首个可用 slug', () => {
    const output = JSON.stringify({
      models: [{ slug: '' }, { slug: 'gpt-6-astra' }, { slug: 'gpt-5.5' }],
    });
    expect(resolveCodexModel({}, () => output)).toBe('gpt-6-astra');
  });

  it('模型探测失败时回退到稳定默认模型', () => {
    expect(resolveCodexModel({}, () => { throw new Error('boom'); })).toBe('gpt-6-luna');
    expect(resolveCodexModel({}, () => 'not-json')).toBe('gpt-6-luna');
    expect(resolveCodexModel({}, () => JSON.stringify({ models: [{ slug: '' }] }))).toBe('gpt-6-luna');
  });
});
