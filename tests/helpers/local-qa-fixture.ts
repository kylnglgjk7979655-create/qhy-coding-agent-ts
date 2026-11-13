import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startLocalOpenAIModel } from './local-openai-fixture.js';
import type { FixtureToolCall } from './local-openai-fixture.js';
import { echoTool, startLocalMCP } from './local-mcp-fixture.js';

function call(id: string, name: string, input: unknown): FixtureToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

export const qaScenarios = ['normal', 'approval-error', 'approval-invalid', 'approval-timeout', 'summary-error', 'summary-invalid'] as const;
type QAScenario = typeof qaScenarios[number];

// 与独立 QA 启动入口共用场景，测试仍从编译后 CLI 和真实协议观察行为。
export async function startLocalQA(scenario: QAScenario = 'normal', reviewDelayMs = 0) {
  const alpha = await startLocalMCP();
  const beta = await startLocalMCP({ sse: true });
  const model = await startLocalOpenAIModel((request) => {
    const current = request.messages.findLastIndex(({ role }) => role === 'user');
    const command = request.messages[current]?.content.trim();
    // 全历史压缩后主模型只收到程序生成的摘要包装；用固定文本表示任务继续，不依赖原文命令。
    if (command?.includes('[对话摘要]')) return { content: '夹具完成：压缩后继续' };
    if (request.messages.slice(current + 1).some(({ role }) => role === 'tool')) {
      return { content: `夹具完成：${command}` };
    }
    if (command === 'remote') return { calls: ['alpha', 'beta'].map((name) => {
      const definition = request.tools.find(({ function: tool }) => tool.name === `mcp_${name}_echo`);
      const properties = definition?.function.parameters?.properties as Record<string, unknown> | undefined;
      return call(`remote-${name}`, `mcp_${name}_echo`, properties?.value ? { value: '新版参数' } : { text: '正常参数' });
    }) };
    if (command === 'pairing') return { calls: [
      call('duplicate', 'write_file', { path: 'pairing.txt', content: '不应写入' }),
      call('duplicate', 'Bash', { command: 'touch later.txt' }),
    ] };
    if (command === 'slow') return { calls: [
      call('slow', 'Bash', { command: 'echo $$ > shell.pid; node worker.cjs & wait' }),
      call('later', 'write_file', { path: 'later.txt', content: '不应写入' }),
      call('remote-later', 'mcp_alpha_echo', { text: '不应调用' }),
    ] };
    if (command === 'oversized') return { calls: [call('huge-read', 'read_file', { path: 'huge.txt' })] };
    if (command === 'growth') return { calls: [
      call('kept-file', 'write_file', { path: 'kept.txt', content: 'kept-file' }),
      call('kept-remote', 'mcp_alpha_echo', { text: 'kept-remote' }),
      call('growth-read', 'read_file', { path: 'large.txt' }),
    ] };
    if (command === 'fault') return { calls: [
      call('kept-file', 'write_file', { path: 'kept.txt', content: 'kept-file' }),
      call('kept-remote', 'mcp_alpha_echo', { text: 'kept-remote' }),
      call('blocked', 'write_file', { path: 'blocked.txt', content: 'blocked' }),
      call('later', 'Bash', { command: 'touch later.txt' }),
    ] };
    if (command === 'mixed') return { calls: [
      call('invalid', 'write_file', { path: 'invalid.txt', content: 'invalid', extra: true }),
      call('unknown', 'missing_tool', {}),
      call('denied', 'write_file', { path: 'denied.txt', content: 'denied' }),
      call('write', 'write_file', { path: 'note.txt', content: 'private-file-content' }),
      call('read', 'read_file', { path: 'note.txt' }),
      call('bash-failure', 'Bash', { command: 'printf private-command-output; exit 7' }),
      call('remote-failure', 'mcp_alpha_echo', { text: 'fail' }),
      call('bash-write', 'Bash', { command: 'printf kept-bash > bash.txt' }),
      call('bash-read', 'read_file', { path: 'bash.txt' }),
      call('remote-ok', 'mcp_beta_echo', { text: 'private-remote-content' }),
      call('tail', 'runtimeInfo', {}),
    ] };
    return { content: `夹具回复：${command}（${scenario}）` };
  }, async (request) => {
    const pending = JSON.parse(request.messages[1]!.content) as { input: { path?: string } };
    if (reviewDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, reviewDelayMs));
    if (scenario === 'approval-invalid' && pending.input.path === 'blocked.txt') return { content: 'invalid-decision' };
    if (scenario === 'approval-timeout' && pending.input.path === 'blocked.txt') return undefined;
    if (scenario === 'approval-error' && pending.input.path === 'blocked.txt') return { status: 500, content: 'private-review-error' };
    return { content: pending.input.path === 'denied.txt' ? 'deny' : 'approve' };
  }, () => scenario === 'summary-error'
    ? { status: 500, content: 'private-summary-error' }
    : scenario === 'summary-invalid' ? { content: ' ' }
    : { content: '目标：继续 QA；决策：沿用工具策略；约束：工作区文件边界；关键结果：此前轮次完成；未完成事项：验证当前轮。' });
  return {
    alpha, beta, model,
    config: {
      model: 'local-qa', baseURL: model.baseURL, apiKeyEnv: 'TEST_MODEL_API_KEY',
      timeoutMs: 10000,
      approval: { mode: 'auto', timeoutMs: 2000 },
      context: { capacityTokens: 19_500, answerReserveTokens: 700, maxOutputTokens: 1_000 },
      mcp: { servers: [
        { name: 'alpha', url: alpha.url, headers: { Authorization: { env: 'QA_MCP_HEADER' } } },
        { name: 'beta', url: beta.url },
      ] },
    },
    close: async () => { await Promise.all([model.close(), alpha.close(), beta.close()]); },
  };
}


// 独立入口只在全新目录生成假凭据配置与可丢弃的数据，绝不覆盖既有验收记录。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: 'string' }, scenario: { type: 'string', default: 'normal' },
      'review-delay-ms': { type: 'string', default: '0' },
    } });
    const scenario = values.scenario as QAScenario;
    const delay = Number(values['review-delay-ms']);
    if (!values.directory || !qaScenarios.includes(scenario) || !Number.isInteger(delay) || delay < 0 || delay > 300000) {
      throw new Error('Invalid arguments');
    }
    const directory = resolve(values.directory);
    await mkdir(directory, { mode: 0o700 });
    const qa = await startLocalQA(scenario, delay);
    try {
      await mkdir(join(directory, 'work'), { mode: 0o700 });
      await mkdir(join(directory, 'work/.agent'), { mode: 0o700 });
      await mkdir(join(directory, '.agent/conversations'), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'work/.agent/settings.json'), JSON.stringify(qa.config, null, 2), { mode: 0o600, flag: 'wx' });
      await writeFile(join(directory, 'work/note.txt'), '初始内容');
      await writeFile(join(directory, 'work/large.txt'), 'private-large-content' + '新'.repeat(1800));
      await writeFile(join(directory, 'work/huge.txt'), '超'.repeat(12000));
      await writeFile(join(directory, 'work/worker.cjs'), "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); fs.writeFileSync('started.txt', 'started'); setTimeout(() => fs.writeFileSync('late.txt', 'leaked'), 2500); setInterval(() => {}, 1000);\n");
      await writeFile(join(directory, '.agent/conversations/qa-summary.json'), JSON.stringify([
        { role: 'user', content: '旧目标：继续 QA；决策：保留工具策略；约束：文件边界。' },
        { role: 'assistant', content: '原文标记' + '旧'.repeat(3000) },
      ]), { mode: 0o600, flag: 'wx' });
    } catch (error) { await qa.close(); throw error; }
    process.stdout.write(`QA_READY ${JSON.stringify({ directory, scenario, model: qa.model.baseURL, alpha: qa.alpha.url, beta: qa.beta.url })}\n`);
    process.stdout.write('CLI 指令：mixed、fault、growth、oversized、remote、pairing、slow、recover。\n夹具终端指令：status、schema-v2、schema-v1、exit。只使用本地假凭据。\n');
    const input = createInterface({ input: process.stdin, terminal: false });
    const stop = () => { input.close(); void qa.close().then(() => process.exit(0)); };
    input.on('line', (line) => {
      if (line === 'exit') { stop(); return; }
      if (line === 'schema-v2') qa.alpha.setTools([{ ...echoTool, description: '新版参数', inputSchema: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
      } }]);
      if (line === 'schema-v1') qa.alpha.setTools([echoTool]);
      if (line === 'status') process.stdout.write(JSON.stringify({
        mainRequests: qa.model.requests.length, approvalRequests: qa.model.approvalRequests.length,
        summaryRequests: qa.model.summaryRequests.length, alphaCalls: qa.alpha.calls.length, betaCalls: qa.beta.calls.length,
      }) + '\n');
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.stderr.write(`夹具启动失败：--directory 必须指定不存在的新目录（父目录须存在），--scenario 可选 ${qaScenarios.join('、')}，--review-delay-ms 为 0–300000 的整数。\n`);
    process.exitCode = 1;
  }
}
