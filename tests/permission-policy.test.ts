import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/services/settings/config.js';
import {
  evaluatePermission,
  parsePermissionRule,
  searchPathAction,
} from '../src/tools/tool-permission-policy.js';
import type { PermissionRuleSet } from '../src/tools/tool-permission-policy.js';
import { tempDir } from './helpers/temp-dir.js';

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await tempDir('qhy-permission-');
  workspaces.push(path);
  return path;
}

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { allow: [], ask: [], deny: [], ...overrides };
}

function configAccepts(rule: string): boolean {
  return configSchema.safeParse({ permissions: { allow: [rule] } }).success;
}

function policyAccepts(rule: string): boolean {
  return parsePermissionRule(rule.trim()) !== undefined;
}

describe('规则语法', () => {
  it.each([
    'Read', 'Read(src/**)', 'Write', 'Write(notes.txt)', 'Edit', 'Edit(src/*.ts)',
    'Glob', 'Glob(src)', 'Grep', 'Grep(*.ts)', 'Bash(npm test)', 'Bash(git status:*)',
    'MCP', 'MCP(server/*)', 'MCP(server/tool)', 'Agent', 'RuntimeInfo', 'TodoWrite',
    'WebFetch', 'WebFetch(domain:example.com)', 'WebSearch',
  ])('接受合法规则：%s', (rule) => {
    expect(parsePermissionRule(rule)).toBeDefined();
    expect(configAccepts(rule)).toBe(true);
  });

  it.each([
    '', 'Bash', 'Bash()', 'Read(', 'Read()', 'Read(a)b', 'Read( )', 'Skill',
    'MCP(Server/*)', 'MCP(server)', 'MCP(server/)', 'MCP(server/*/*)', 'MCP(server/a b)',
    'WebFetch(domain:)', 'WebFetch(example.com)', 'Agent(extra)', 'RuntimeInfo(x)',
    'Glob(a())', 'unknown',
  ])('拒绝非法规则：%s', (rule) => {
    expect(parsePermissionRule(rule.trim())).toBeUndefined();
    expect(configAccepts(rule)).toBe(false);
  });

  it('配置校验与运行时解析接受集合一致', () => {
    const candidates = [
      'Read', 'Read(*)', 'Write(x)', 'Edit', 'Glob', 'Grep(a/**)', 'Bash(echo hi)',
      'MCP', 'MCP(s/*)', 'MCP(s/t)', 'Agent', 'RuntimeInfo', 'TodoWrite', 'WebFetch',
      'WebFetch(domain:*.example.com)', 'WebSearch', 'Bash', 'MCP(S/*)', 'Read()', 'Skill',
    ];
    for (const rule of candidates) {
      expect(configAccepts(rule), rule).toBe(policyAccepts(rule));
    }
  });
});

describe('规则优先级', () => {
  const target = '/workspace/note.txt';
  const readFacts = { tool: 'read_file' as const, requestedPath: 'note.txt', target };

  it('deny 优先于 ask 与 allow', () => {
    const decision = evaluatePermission({
      workspace: '/workspace', rules: rules({ allow: ['Read'], ask: ['Read'], deny: ['Read'] }), facts: readFacts,
    });
    expect(decision).toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('ask 优先于 allow', () => {
    const decision = evaluatePermission({
      workspace: '/workspace', rules: rules({ allow: ['Read'], ask: ['Read'] }), facts: readFacts,
    });
    expect(decision).toEqual({ outcome: 'ask', reason: 'rule' });
  });

  it('allow 命中时直接允许', () => {
    const decision = evaluatePermission({
      workspace: '/workspace', rules: rules({ allow: ['Read'] }), facts: readFacts,
    });
    expect(decision).toEqual({ outcome: 'allow', reason: 'rule' });
  });

  it('不同能力规则互不误用', () => {
    const decision = evaluatePermission({
      workspace: '/workspace',
      rules: rules({ deny: ['Write'], ask: ['Glob'], allow: ['Grep'] }),
      facts: readFacts,
    });
    expect(decision).toEqual({ outcome: 'allow', reason: 'default' });
  });

  it('Edit 同时受 Edit 与 Write 规则约束', () => {
    const facts = { tool: 'edit' as const, requestedPath: 'note.txt', target };
    expect(evaluatePermission({ workspace: '/workspace', rules: rules({ deny: ['Write'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: '/workspace', rules: rules({ ask: ['Edit'] }), facts }))
      .toEqual({ outcome: 'ask', reason: 'rule' });
    expect(evaluatePermission({ workspace: '/workspace', rules: rules({ allow: ['Write'] }), facts }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
  });
});

describe('路径规则', () => {
  it('相对规则从工作区解析，支持 *、? 与 **', async () => {
    const root = await workspace();
    const facts = { tool: 'read_file' as const, requestedPath: 'src/deep/file.ts', target: join(root, 'src', 'deep', 'file.ts') };
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(src/**)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(src/f?le.ts)'] }), facts }))
      .toEqual({ outcome: 'allow', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(src/deep/*.ts)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(src/*/file.ts)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('绝对路径与 ~ 规则按真实用户目录解析', () => {
    const target = join(homedir(), 'notes', 'secret.txt');
    const facts = { tool: 'read_file' as const, requestedPath: '~/notes/secret.txt', target };
    expect(evaluatePermission({ workspace: '/workspace', rules: rules({ deny: ['Read(~/notes/**)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: '/workspace', rules: rules({ deny: [`Read(${join(homedir(), 'notes', 'secret.txt')})`] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('规则同时匹配请求路径与实际目标，防符号链接绕过', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const facts = { tool: 'read_file' as const, requestedPath: 'link.txt', target: join(outside, 'secret.txt') };
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: [`Read(${join(outside, 'secret.txt')})`] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Read(link.txt)'] }), facts }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
  });

  it('不存在的写入目标按最近存在祖先目录规范化', async () => {
    const root = await workspace();
    await mkdir(join(root, 'existing'));
    const facts = {
      tool: 'write_file' as const,
      requestedPath: 'existing/new/file.txt',
      target: join(root, 'existing', 'new', 'file.txt'),
    };
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Write(existing/new/**)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('精确文件与子树规则边界不同', async () => {
    const root = await workspace();
    const exact = { tool: 'read_file' as const, requestedPath: 'notes/a.txt', target: join(root, 'notes', 'a.txt') };
    const nested = { tool: 'read_file' as const, requestedPath: 'notes/deep/a.txt', target: join(root, 'notes', 'deep', 'a.txt') };
    const subtree = rules({ deny: ['Read(notes)'] });
    expect(evaluatePermission({ workspace: root, rules: subtree, facts: nested }).outcome).toBe('allow');
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(notes/**)'] }), facts: nested }).outcome).toBe('deny');
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(notes/a.txt)'] }), facts: exact }).outcome).toBe('deny');
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Read(notes/*.txt)'] }), facts: exact }).outcome).toBe('deny');
  });
});

describe('工具默认权限', () => {
  const root = '/workspace';
  const inside = join(root, 'inside.txt');
  const outside = '/outside/secret.txt';

  it('read_file 工作区内允许，工作区外审批', () => {
    expect(evaluatePermission({ workspace: root, rules: rules(), facts: { tool: 'read_file', requestedPath: 'inside.txt', target: inside } }))
      .toEqual({ outcome: 'allow', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules(), facts: { tool: 'read_file', requestedPath: outside, target: outside } }))
      .toEqual({ outcome: 'ask', reason: 'outside-workspace' });
  });

  it('显式 Read allow 可免除工作区外默认审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules({ allow: ['Read'] }),
      facts: { tool: 'read_file', requestedPath: outside, target: outside },
    })).toEqual({ outcome: 'allow', reason: 'rule' });
  });

  it('write_file 默认审批，显式 allow 免除', () => {
    expect(evaluatePermission({ workspace: root, rules: rules(), facts: { tool: 'write_file', requestedPath: 'a.txt', target: join(root, 'a.txt') } }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Write'] }), facts: { tool: 'write_file', requestedPath: 'a.txt', target: join(root, 'a.txt') } }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
  });

  it('glob/grep 工作区内根允许，工作区外根审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules(),
      facts: { tool: 'glob', requestedPath: '.', target: root, searchAsks: [] },
    })).toEqual({ outcome: 'allow', reason: 'default' });
    expect(evaluatePermission({
      workspace: root, rules: rules(),
      facts: { tool: 'grep', requestedPath: outside, target: '/outside', searchAsks: [] },
    })).toEqual({ outcome: 'ask', reason: 'outside-workspace' });
  });

  it('搜索范围含需审批路径时进入显式审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules(),
      facts: { tool: 'grep', requestedPath: '.', target: root, searchAsks: ['needs-review.txt'] },
    })).toEqual({ outcome: 'ask', reason: 'search-scope' });
  });

  it('拒绝搜索根直接拒绝，即使存在 allow 规则', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules({ allow: ['Grep'], deny: ['Grep(private)'] }),
      facts: { tool: 'grep', requestedPath: 'private', target: join(root, 'private'), searchAsks: [] },
    })).toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('Bash 无匹配规则时默认审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules(),
      facts: { tool: 'Bash', commands: ['echo hi'], requiresExtraApproval: false },
    })).toEqual({ outcome: 'ask', reason: 'default' });
  });

  it('MCP 无匹配规则时默认审批', () => {
    expect(evaluatePermission({ workspace: root, rules: rules(), facts: { tool: 'mcp', server: 'remote', remoteTool: 'read' } }))
      .toEqual({ outcome: 'ask', reason: 'default' });
  });

  it.each([
    ['agent', { tool: 'agent' as const }],
    ['runtimeInfo', { tool: 'runtimeInfo' as const }],
    ['skill', { tool: 'skill' as const }],
    ['todoWrite', { tool: 'todoWrite' as const }],
  ])('%s 默认允许', (_name, facts) => {
    expect(evaluatePermission({ workspace: root, rules: rules(), facts })).toEqual({ outcome: 'allow', reason: 'default' });
  });

  it('Agent 与 RuntimeInfo 的 deny/ask 规则继续生效', () => {
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['Agent'] }), facts: { tool: 'agent' } }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ ask: ['RuntimeInfo'] }), facts: { tool: 'runtimeInfo' } }))
      .toEqual({ outcome: 'ask', reason: 'rule' });
  });

  it('网络工具无匹配规则时默认审批，allow 可免除', () => {
    expect(evaluatePermission({ workspace: root, rules: rules(), facts: { tool: 'webFetch' } }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['WebSearch'] }), facts: { tool: 'webSearch' } }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
  });

  it('WebFetch 域名规则按主机匹配', () => {
    const facts = { tool: 'webFetch' as const, hostname: 'docs.example.com' };
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['WebFetch(domain:*.example.com)'] }), facts }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['WebFetch(domain:example.com)'] }), facts }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['WebFetch'] }), facts }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
  });
});

describe('Bash 命令归约', () => {
  const root = '/workspace';
  const bash = (commands: string[], requiresExtraApproval = false) =>
    ({ tool: 'Bash' as const, commands, requiresExtraApproval });

  it('精确匹配与 :* 前缀边界一致', () => {
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Bash(npm test)'] }), facts: bash(['npm test']) }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Bash(npm test)'] }), facts: bash(['npm test --watch']) }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Bash(npm test:*)'] }), facts: bash(['npm test --watch']) }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['Bash(npm test:*)'] }), facts: bash(['npm testing']) }))
      .toEqual({ outcome: 'ask', reason: 'default' });
  });

  it('多条简单命令必须全部命中 allow 才允许', () => {
    const allow = rules({ allow: ['Bash(echo:*)'] });
    expect(evaluatePermission({ workspace: root, rules: allow, facts: bash(['echo one', 'echo two']) }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: allow, facts: bash(['echo one', 'rm file']) }))
      .toEqual({ outcome: 'ask', reason: 'default' });
  });

  it('任一 deny 拒绝整条，任一 ask 进入显式审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules({ allow: ['Bash(echo:*)'], deny: ['Bash(rm:*)'] }),
      facts: bash(['echo one', 'rm file']),
    })).toEqual({ outcome: 'deny', reason: 'rule' });
    expect(evaluatePermission({
      workspace: root, rules: rules({ allow: ['Bash(echo:*)'], ask: ['Bash(git:*)'] }),
      facts: bash(['echo one', 'git status']),
    })).toEqual({ outcome: 'ask', reason: 'rule' });
  });

  it('全部 allow 但需要额外审批时仍审批', () => {
    expect(evaluatePermission({
      workspace: root, rules: rules({ allow: ['Bash(echo:*)'] }),
      facts: bash(['echo one > file'], true),
    })).toEqual({ outcome: 'ask', reason: 'bash-extra-approval' });
  });
});

describe('MCP 身份匹配', () => {
  const root = '/workspace';
  const mcp = (server: string, remoteTool: string) => ({ tool: 'mcp' as const, server, remoteTool });

  it('裸 MCP、server/* 与 server/tool 语义不变', () => {
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['MCP'] }), facts: mcp('remote', 'read') }))
      .toEqual({ outcome: 'allow', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ ask: ['MCP(remote/*)'] }), facts: mcp('remote', 'write') }))
      .toEqual({ outcome: 'ask', reason: 'rule' });
    expect(evaluatePermission({ workspace: root, rules: rules({ deny: ['MCP(remote/read)'] }), facts: mcp('remote', 'read') }))
      .toEqual({ outcome: 'deny', reason: 'rule' });
  });

  it('其他服务、其他工具与大小写不匹配时使用默认审批', () => {
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['MCP(other/*)'] }), facts: mcp('remote', 'read') }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['MCP(remote/write)'] }), facts: mcp('remote', 'read') }))
      .toEqual({ outcome: 'ask', reason: 'default' });
    expect(evaluatePermission({ workspace: root, rules: rules({ allow: ['MCP(Remote/*)'] }), facts: mcp('remote', 'read') }))
      .toEqual({ outcome: 'ask', reason: 'default' });
  });
});

describe('搜索路径回调', () => {
  it('按路径规则返回 allow/ask/deny/undefined', async () => {
    const root = await workspace();
    await mkdir(join(root, 'review'));
    await mkdir(join(root, 'private'));
    const input = (path: string) => ({ rules: rules({
      allow: ['Grep(public/**)'], ask: ['Grep(review/**)'], deny: ['Grep(private)', 'Grep(private/**)'],
    }), workspace: root, capability: 'Grep' as const, path: join(root, path) });

    expect(searchPathAction(input('public/a.txt'))).toBe('allow');
    expect(searchPathAction(input('review/a.txt'))).toBe('ask');
    expect(searchPathAction(input('private/a.txt'))).toBe('deny');
    expect(searchPathAction(input('other/a.txt'))).toBeUndefined();
  });

  it('Glob 与 Grep 规则互不影响', async () => {
    const root = await workspace();
    const ruleset = rules({ deny: ['Glob(private)'] });
    expect(searchPathAction({ rules: ruleset, workspace: root, capability: 'Glob', path: join(root, 'private') })).toBe('deny');
    expect(searchPathAction({ rules: ruleset, workspace: root, capability: 'Grep', path: join(root, 'private') })).toBeUndefined();
  });

  it('拒绝优先于允许与审批', async () => {
    const root = await workspace();
    expect(searchPathAction({
      rules: rules({ allow: ['Glob'], ask: ['Glob(x/**)'], deny: ['Glob(x/secret.txt)'] }),
      workspace: root, capability: 'Glob', path: join(root, 'x', 'secret.txt'),
    })).toBe('deny');
  });
});