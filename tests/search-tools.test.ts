import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { runAgent } from '../src/query/agent.js';
import type { ResolvedConfig } from '../src/services/settings/config.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';

it('Agent 可用 glob 和 grep 搜索工作区，包含隐藏目录并遵循忽略规则', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-search-tools-'));
  const outside = await mkdtemp(join(tmpdir(), 'qhy-search-outside-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(workspace, '.hidden'));
    await mkdir(join(workspace, 'linked-rules'));
    await writeFile(join(workspace, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(workspace, '.hidden', '.gitignore'), 'excluded.txt\n');
    await writeFile(join(outside, '.gitignore'), 'secret.txt\n');
    await symlink(join(outside, '.gitignore'), join(workspace, 'linked-rules', '.gitignore'));
    await writeFile(join(workspace, 'visible.txt'), 'needle visible\n');
    await writeFile(join(workspace, 'ignored.txt'), 'needle ignored\n');
    await writeFile(join(workspace, '.hidden', 'secret.txt'), 'needle hidden\n');
    await writeFile(join(workspace, '.hidden', 'excluded.txt'), 'needle excluded\n');
    await writeFile(join(workspace, 'linked-rules', 'secret.txt'), 'needle inside\n');
    await writeFile(join(outside, 'outside.txt'), 'needle outside\n');
    await symlink(join(outside, 'outside.txt'), join(workspace, 'escape.txt'));

    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'search-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) } },
      { id: 'search-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle', glob: '**/*.txt' }) } },
      { id: 'search-empty', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'no-such-match' }) } },
    ] } : { content: '搜索完成' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const events: string[] = [];
    await runAgent(config, '搜索 needle 并找出 txt 文件', {
      smokeTool: false,
      onToolEvent: (event) => events.push(`${event.toolName}:${event.status}`),
    });

    expect(fixture.requests[0]!.tools.map(({ function: definition }) => definition.name)).toEqual(expect.arrayContaining(['glob', 'grep']));
    expect(fixture.approvalRequests).toHaveLength(0);
    const results = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
    const globResult = JSON.parse(results.find(({ tool_call_id }) => tool_call_id === 'search-glob')!.content);
    const grepResult = JSON.parse(results.find(({ tool_call_id }) => tool_call_id === 'search-grep')!.content);
    expect(globResult).toEqual({ is_error: false, output: { paths: ['.hidden/secret.txt', 'linked-rules/secret.txt', 'visible.txt'], truncated: false } });
    expect(grepResult).toEqual({ is_error: false, output: { matches: [
      { path: '.hidden/secret.txt', line: 1, text: 'needle hidden' },
      { path: 'linked-rules/secret.txt', line: 1, text: 'needle inside' },
      { path: 'visible.txt', line: 1, text: 'needle visible' },
    ], truncated: false } });
    expect(JSON.parse(results.find(({ tool_call_id }) => tool_call_id === 'search-empty')!.content))
      .toEqual({ is_error: false, output: { matches: [], truncated: false } });
    expect(events.filter((event) => event.endsWith(':succeeded'))).toEqual(['glob:succeeded', 'grep:succeeded', 'grep:succeeded']);
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('搜索工具限定子目录、拒绝越界路径并标记截断结果', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-search-limits-'));
  const outside = await mkdtemp(join(tmpdir(), 'qhy-search-outside-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(workspace, 'only-here'));
    await writeFile(join(workspace, 'only-here', 'many.txt'), Array.from({ length: 205 }, (_, index) => `needle ${index}`).join('\n'));
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(join(workspace, 'only-here', `item-${String(index).padStart(3, '0')}.txt`), 'no match'),
    ));
    await writeFile(join(workspace, 'elsewhere.txt'), 'needle elsewhere');
    await writeFile(join(outside, 'private.txt'), 'needle outside');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'limit-glob', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*.txt","path":"only-here"}' } },
      { id: 'limit-grep', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle","path":"only-here","glob":"*.txt"}' } },
      { id: 'escape-absolute', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*', path: outside }) } },
      { id: 'escape-relative', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle', path: `../${basename(outside)}` }) } },
      { id: 'invalid-regex', type: 'function', function: { name: 'grep', arguments: '{"pattern":"["}' } },
    ] } : { content: '边界与截断已验证' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const events: Array<{ callId: string; status: string; errorCode?: string }> = [];
    const approvals: string[] = [];
    await runAgent(config, '搜索子目录并检查边界', {
      smokeTool: false,
      approvalControl: async ({ toolName }) => { approvals.push(toolName); return 'approve'; },
      onToolEvent: (event) => events.push(event),
    });
    const results = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
    const output = (id: string) => JSON.parse(results.find(({ tool_call_id }) => tool_call_id === id)!.content);
    expect(output('limit-glob').output.paths).toHaveLength(200);
    expect(output('limit-glob').output.truncated).toBe(true);
    expect(output('limit-grep').output.matches).toHaveLength(200);
    expect(output('limit-grep').output.truncated).toBe(true);
    expect(output('escape-absolute').output.paths).toEqual([`${relative(workspace, outside)}/private.txt`]);
    expect(output('escape-relative').output.matches).toEqual([{ path: `${relative(workspace, outside)}/private.txt`, line: 1, text: 'needle outside' }]);
    expect(output('invalid-regex').error.code).toBe('INVALID_TOOL_ARGUMENTS');
    expect(events.filter(({ status }) => status === 'rejected').map(({ callId, errorCode }) => [callId, errorCode]).sort(([left], [right]) => String(left).localeCompare(String(right)))).toEqual([
      ['invalid-regex', 'INVALID_TOOL_ARGUMENTS'],
    ]);
    expect(approvals.sort()).toEqual(['glob', 'grep']);
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('Glob 与 Grep 按各自权限范围剪枝并汇总审批', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-search-permissions-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(workspace, 'private'));
    await mkdir(join(workspace, 'review-zone'));
    await writeFile(join(workspace, 'private', 'secret.txt'), 'needle forbidden body');
    await symlink(join(workspace, 'private', 'secret.txt'), join(workspace, 'private-link.txt'));
    await writeFile(join(workspace, 'needs-review.txt'), 'needle reviewed body');
    await writeFile(join(workspace, 'review-zone', 'review-denied.txt'), 'needle denied review body');
    await writeFile(join(workspace, 'public.txt'), 'needle public body');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'permission-glob', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*.txt"}' } },
      { id: 'permission-grep', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle"}' } },
      { id: 'permission-root-deny', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle","path":"private"}' } },
      { id: 'permission-ask-deny', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle","path":"review-zone"}' } },
    ] } : { content: '权限范围已处理' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000 },
      permissions: { allow: ['Read'], ask: ['Grep(needs-review.txt)', 'Grep(review-zone)'], deny: [
        'Read(private)', 'Glob(private)', 'Grep(private)', 'Grep(private/secret.txt)',
        'Glob(private/secret.txt)',
      ] },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const approvals: string[] = [];
    const approvalScopes: string[] = [];
    await runAgent(config, '搜索工作区文本', {
      smokeTool: false,
      approvalControl: async ({ toolName, input, details }) => {
        approvals.push(toolName);
        if (details?.searchAsk) approvalScopes.push(details.searchAsk);
        expect(input).toMatchObject({ pattern: 'needle' });
        return (input as { path?: string }).path === 'review-zone' ? 'deny' : 'approve';
      },
    });
    const results = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
    const output = (id: string) => JSON.parse(results.find(({ tool_call_id }) => tool_call_id === id)!.content);
    expect(output('permission-glob')).toMatchObject({ is_error: false, output: {
      paths: ['needs-review.txt', 'public.txt', 'review-zone/review-denied.txt'],
      permission_excluded: ['private', 'private-link.txt'],
    } });
    expect(output('permission-grep')).toMatchObject({ is_error: false, output: {
      matches: [
        { path: 'needs-review.txt', text: 'needle reviewed body' },
        { path: 'public.txt', text: 'needle public body' },
        { path: 'review-zone/review-denied.txt', text: 'needle denied review body' },
      ], permission_excluded: ['private', 'private-link.txt'],
    } });
    expect(output('permission-grep').output.matches.map(({ text }: { text: string }) => text).join('\n')).not.toContain('forbidden body');
    expect(output('permission-root-deny').error.code).toBe('PERMISSION_DENIED');
    expect(output('permission-ask-deny').error.code).toBe('PERMISSION_DENIED');
    expect(approvalScopes.sort()).toEqual(['["needs-review.txt","review-zone"]', '["review-zone"]']);
    expect(approvals).toEqual(['grep', 'grep']);
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

it('搜索审批后新增的 ask 范围不会被未覆盖的先前批准放行', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-search-scope-change-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(workspace, 'reviewed.txt'), 'needle approved body');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'scope-change', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle"}' } },
    ] } : { content: '搜索完成' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', rules: [], timeoutMs: 30_000 },
      permissions: { allow: [], ask: ['Grep(reviewed.txt)', 'Grep(new-review.txt)'], deny: [] },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 4,
    };
    await runAgent(config, '搜索经审批的文件', {
      smokeTool: false,
      approvalControl: async () => {
        await writeFile(join(workspace, 'new-review.txt'), 'needle not approved body');
        return 'approve';
      },
    });

    const result = JSON.parse(fixture.requests[1]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(result).toMatchObject({ is_error: true });
    expect(JSON.stringify(result)).not.toContain('not approved body');
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.each(['glob', 'grep'] as const)('%s 外部搜索根在审批期间改向后拒绝搜索新目标', async (toolName) => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-search-root-change-work-'));
  const outside = await mkdtemp(join(tmpdir(), 'qhy-search-root-change-outside-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    const first = join(outside, 'first');
    const second = join(outside, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'first.txt'), 'needle approved target');
    await writeFile(join(second, 'second.txt'), 'needle unapproved target');
    await symlink(first, join(workspace, 'link'));
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'root-change', type: 'function', function: { name: toolName, arguments: JSON.stringify(
        toolName === 'glob' ? { pattern: '*.txt', path: 'link' } : { pattern: 'needle', path: 'link' },
      ) } },
    ] } : { content: '搜索完成' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 4,
    };

    await runAgent(config, '搜索获批目标', {
      smokeTool: false,
      approvalControl: async () => {
        await rm(join(workspace, 'link'));
        await symlink(second, join(workspace, 'link'));
        return 'approve';
      },
    });

    const result = JSON.parse(fixture.requests[1]!.messages.find(({ role }) => role === 'tool')!.content);
    expect(result).toMatchObject({ is_error: true });
    expect(JSON.stringify(result)).not.toContain('unapproved target');
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('工作区外 Glob 与 Grep 经逐次审批后返回搜索结果', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qhy-external-search-work-'));
  const outside = await mkdtemp(join(tmpdir(), 'qhy-external-search-outside-'));
  let closeFixture: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(outside, 'outside.txt'), 'external needle');
    const fixture = await startLocalOpenAIModel((_request, index) => index === 1 ? { calls: [
      { id: 'external-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: outside }) } },
      { id: 'external-grep', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle', path: outside }) } },
    ] } : { content: '外部搜索完成' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'default', timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 4,
    };
    const approvals: string[] = [];

    await runAgent(config, '搜索工作区外目录', {
      smokeTool: false,
      approvalControl: async ({ toolName, details }) => {
        approvals.push(`${toolName}:${details?.target}`);
        return 'approve';
      },
    });

    expect(approvals).toEqual([`glob:${outside}`, `grep:${outside}`]);
    const results = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string }>;
    expect(JSON.parse(results[0]!.content)).toMatchObject({ is_error: false, output: { paths: [`../${basename(outside)}/outside.txt`] } });
    expect(JSON.parse(results[1]!.content)).toMatchObject({ is_error: false, output: { matches: [expect.objectContaining({ text: 'external needle' })] } });
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
