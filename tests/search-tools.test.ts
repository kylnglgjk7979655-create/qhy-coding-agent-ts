import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      { id: 'escape-relative', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle","path":"../"}' } },
      { id: 'invalid-regex', type: 'function', function: { name: 'grep', arguments: '{"pattern":"["}' } },
    ] } : { content: '边界与截断已验证' });
    closeFixture = fixture.close;
    const config: ResolvedConfig = {
      approval: { mode: 'auto', rules: [], timeoutMs: 30_000 },
      provider: 'openai', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture-key',
      baseURL: fixture.baseURL, workspace: await realpath(workspace), timeoutMs: 3000, maxSteps: 5,
    };
    const events: Array<{ callId: string; status: string; errorCode?: string }> = [];
    await runAgent(config, '搜索子目录并检查边界', {
      smokeTool: false,
      onToolEvent: (event) => events.push(event),
    });
    const results = fixture.requests[1]!.messages.filter(({ role }) => role === 'tool') as unknown as Array<{ content: string; tool_call_id: string }>;
    const output = (id: string) => JSON.parse(results.find(({ tool_call_id }) => tool_call_id === id)!.content);
    expect(output('limit-glob').output.paths).toHaveLength(200);
    expect(output('limit-glob').output.truncated).toBe(true);
    expect(output('limit-grep').output.matches).toHaveLength(200);
    expect(output('limit-grep').output.truncated).toBe(true);
    expect(output('escape-absolute').error.code).toBe('INVALID_TOOL_ARGUMENTS');
    expect(output('escape-relative').error.code).toBe('INVALID_TOOL_ARGUMENTS');
    expect(output('invalid-regex').error.code).toBe('INVALID_TOOL_ARGUMENTS');
    expect(events.filter(({ status }) => status === 'rejected').map(({ callId, errorCode }) => [callId, errorCode]).sort(([left], [right]) => String(left).localeCompare(String(right)))).toEqual([
      ['escape-absolute', 'INVALID_TOOL_ARGUMENTS'],
      ['escape-relative', 'INVALID_TOOL_ARGUMENTS'],
      ['invalid-regex', 'INVALID_TOOL_ARGUMENTS'],
    ]);
  } finally {
    await closeFixture?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
