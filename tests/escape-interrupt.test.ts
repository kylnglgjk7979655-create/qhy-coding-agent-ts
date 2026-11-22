import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCLI } from './helpers/cli-process.js';
import { startLocalOpenAIModel } from './helpers/local-openai-fixture.js';
import type { FixtureRequest } from './helpers/local-openai-fixture.js';
import { readStoredSession } from './helpers/session-store.js';

const secret = 'escape-interrupt-test-key';
const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof startLocalOpenAIModel>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitFor(predicate: () => boolean, describe: () => string, timeout = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = (): void => {
      if (predicate()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error(`等待 CLI 状态超时：${describe()}`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserText(request: FixtureRequest): string {
  return request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
}

/** 去掉终端控制序列后以 `>` 结尾，表示主循环已重新显示输入提示符。 */
function promptReady(output: string): boolean {
  return output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd().endsWith('>');
}

async function waitForPrompt(output: () => string): Promise<void> {
  await waitFor(() => promptReady(output()), () => `等待输入提示符，输出=${output()}`);
}

async function setup(
  respond: Parameters<typeof startLocalOpenAIModel>[0],
  extra: Record<string, unknown> = {},
  summarize?: Parameters<typeof startLocalOpenAIModel>[2],
) {
  const cwd = await mkdtemp(join(tmpdir(), 'qhy-escape-workspace-'));
  const userDir = await mkdtemp(join(tmpdir(), 'qhy-escape-user-'));
  roots.push(cwd, userDir);
  const model = await startLocalOpenAIModel(respond, undefined, summarize);
  fixtures.push(model);
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await writeFile(join(cwd, '.agent', 'settings.json'), JSON.stringify({
    model: 'fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: model.baseURL,
    timeoutMs: 8000, maxSteps: 10, approval: { mode: 'default', humanTimeoutMs: 5000 },
    ...extra,
  }));
  let output = '';
  const cli = startCLI({ cwd, userDir, conversationId: 'escape', pty: true, env: { TEST_MODEL_API_KEY: secret } }, (value) => { output = value; });
  return { cwd, userDir, model, cli, output: () => output };
}

describe.skipIf(process.platform === 'win32')('交互终端 Esc 中断', () => {
  it('生成回复时按 Esc 取消本轮，并在同一会话继续下一轮', async () => {
    const { model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '生成中的回答' } },
        { delta: { content: '不应出现的结尾' }, finish_reason: 'stop', delayMs: 2000 },
      ] }
      : { content: '第二轮完成' });
    await waitForPrompt(output);
    cli.send('开始生成长回答\n');
    await waitFor(() => output().includes('生成中的回答') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    expect(output()).not.toContain('不应出现的结尾');
    await waitForPrompt(output);

    cli.send('继续下一轮\n');
    await waitFor(() => output().includes('第二轮完成'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe('继续下一轮');
  });

  it('人工审批菜单打开时 Esc 只拒绝当前调用，轮次继续', async () => {
    const { cwd, model, cli, output } = await setup((_request, index) => index === 1
      ? { calls: [{ id: 'escape-deny', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'denied.txt', content: '不应写入' }) } }] }
      : { content: '审批拒绝后继续完成' });
    await waitForPrompt(output);
    cli.send('请求写入\n');
    await waitFor(() => output().includes('[人工审批 1] write_file'), () => `输出=${output()}`);
    await waitFor(() => output().includes('1. 批准本次'), () => `输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('已拒绝本次'), () => `输出=${output()}`);
    expect(output()).not.toContain('用户中断');
    await waitFor(() => output().includes('审批拒绝后继续完成'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    await expect(readFile(join(cwd, 'denied.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(model.requests).toHaveLength(2);
    const toolMessage = model.requests[1]!.messages.find(({ role }) => role === 'tool')!;
    expect(JSON.parse(toolMessage.content)).toMatchObject({ is_error: true, error: { code: 'PERMISSION_DENIED' } });
  });

  it('工具执行期间 Esc 沿用轮次取消语义并允许同会话继续', async () => {
    const { model, cli, output } = await setup((_request, index) => index === 1
      ? { calls: [{ id: 'esc-sleep', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'sleep 30' }) } }] }
      : { content: '工具取消后继续' }, { permissions: { allow: ['Bash(sleep:*)'] } });
    await waitForPrompt(output);
    cli.send('运行可中断工具\n');
    await waitFor(() => output().includes('Bash(') && output().includes('运行中'), () => `输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    await waitForPrompt(output);
    cli.send('恢复输入\n');
    await waitFor(() => output().includes('工具取消后继续'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).not.toContain('esc-sleep');
    expect(JSON.stringify(model.requests[1])).toContain('恢复输入');
  });

  it('第一轮执行中按 Esc：取消按下时的轮次，已排队的下一轮不受影响', async () => {
    const { model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '第一轮开始' } },
        // 按键判定窗口约 500ms；第一轮在该窗口结束后仍应继续执行，才能证明取消生效。
        { delta: { content: '第一轮自然结束' }, finish_reason: 'stop', delayMs: 900 },
      ] }
      : { frames: [
        { delta: { content: '第二轮开始' } },
        { delta: { content: '第二轮完成_MARKER' }, finish_reason: 'stop', delayMs: 800 },
      ] });
    await waitForPrompt(output);
    cli.send('第一轮请求\n');
    await waitFor(() => output().includes('第一轮开始') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    // 先排队第二轮，再按 Esc：按键发生在第一轮，取消只应作用于第一轮。
    cli.send('第二轮请求\n');
    const pressedAt = Date.now();
    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    // 独立 Esc 在历史判定窗口内给出结论，不能无限等待后续字节。
    expect(Date.now() - pressedAt).toBeLessThan(3000);
    await waitFor(() => output().includes('第二轮完成_MARKER'), () => `请求数=${model.requests.length}，输出=${output()}`, 12000);
    // 第一轮在按键判定时仍在执行，已随取消终止，不会再输出自然结束后半段。
    expect(output()).not.toContain('第一轮自然结束');
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe('第二轮请求');
  });

  it('第一轮在 Esc 判定前自然结束：迟到判定不会取消已排队的下一轮', async () => {
    const { model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '第一轮开始' } },
        // 第一轮在约 300ms 自然结束，早于约 500ms 的按键判定；判定结果不得顺延到下一轮。
        { delta: { content: '第一轮自然结束' }, finish_reason: 'stop', delayMs: 300 },
      ] }
      : { frames: [
        { delta: { content: '第二轮开始' } },
        { delta: { content: '第二轮完成_MARKER' }, finish_reason: 'stop', delayMs: 800 },
      ] });
    await waitForPrompt(output);
    cli.send('第一轮请求\n');
    await waitFor(() => output().includes('第一轮开始') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    // 先排队第二轮，再按 Esc：按键归属于第一轮，第一轮结束后不得取消第二轮。
    cli.send('第二轮请求\n');
    cli.send('\x1b');
    await waitFor(() => output().includes('第二轮完成_MARKER'), () => `请求数=${model.requests.length}，输出=${output()}`, 12000);
    await waitFor(() => output().includes('第一轮自然结束'), () => `输出=${output()}`);
    expect(output()).not.toContain('用户中断');
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe('第二轮请求');
  });

  it('Esc 取消后不启动按键前尚未开始的工具，下一轮仍可继续', async () => {
    const { cwd, model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '准备调用工具' } },
        { delta: { tool_calls: [{ index: 0, id: 'late-tool', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'touch late-tool.txt' }) } }] }, delayMs: 300 },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '取消后继续完成' }, { permissions: { allow: ['Bash(touch:*)'] } });
    await waitForPrompt(output);
    cli.send('先输出再调用工具\n');
    await waitFor(() => output().includes('准备调用工具') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    await waitForPrompt(output);
    // 留出超过工具计划启动的 300ms，确认取消在按键当下生效而不是等事件迟到后才生效。
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(join(cwd, 'late-tool.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    cli.send('继续下一轮\n');
    await waitFor(() => output().includes('取消后继续完成'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe('继续下一轮');
  });

  it('轮次执行中方向键转义序列不会触发取消', async () => {
    const { model, cli, output } = await setup(() => ({ frames: [
      { delta: { content: '长流开始' } },
      { delta: { content: '长流完成_MARKER' }, finish_reason: 'stop', delayMs: 900 },
    ] }));
    await waitForPrompt(output);
    cli.send('长流请求\n');
    await waitFor(() => output().includes('长流开始'), () => `输出=${output()}`);

    // 左右方向键均以 ESC 开头，原始输入解析不能把它们当成独立 Esc。
    cli.send('\x1b[D');
    cli.send('\x1b[C');
    await waitFor(() => output().includes('长流完成_MARKER'), () => `输出=${output()}`, 10000);
    expect(output()).not.toContain('用户中断');
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(1);
  });

  it('轮次执行中拆包方向键不会触发取消（历史窗口内的 40/100/225/250/400ms 间隔）', async () => {
    // 真实 PTY 会把方向键拆成 ESC 与 [D 两次写入；历史 readline 窗口（约 500ms）内
    // 的间隔不能决定它是不是独立 Esc，否则会收窄原始实现可用的兼容区间。
    for (const gap of [40, 100, 225, 250, 400]) {
      const marker = `长流完成_${gap}ms_MARKER`;
      const { model, cli, output } = await setup(() => ({ frames: [
        { delta: { content: '长流开始' } },
        { delta: { content: marker }, finish_reason: 'stop', delayMs: 1200 },
      ] }));
      await waitForPrompt(output);
      cli.send('长流请求\n');
      await waitFor(() => output().includes('长流开始'), () => `间隔=${gap}ms，输出=${output()}`);
      await sleep(60);
      cli.send('\x1b');
      await sleep(gap);
      cli.send('[D');
      await waitFor(() => output().includes(marker), () => `间隔=${gap}ms，输出=${output()}`, 8000);
      expect(output(), `间隔=${gap}ms 不应取消轮次`).not.toContain('用户中断');
      cli.end('/exit\n');
      const result = await cli.done;
      expect(result.code, `间隔=${gap}ms：${result.stdout}${result.stderr}`).toBe(0);
      expect(model.requests, `间隔=${gap}ms`).toHaveLength(1);
    }
  });

  it('空闲草稿中拆包方向键仍按光标移动处理（历史窗口内的 40/100/225/250/400ms 间隔）', async () => {
    for (const gap of [40, 100, 225, 250, 400]) {
      const { model, cli, output } = await setup((request) => ({ content: `收到:${lastUserText(request)}` }));
      await waitForPrompt(output);
      cli.send('AB');
      await sleep(120);
      cli.send('\x1b');
      await sleep(gap);
      cli.send('[D');
      await sleep(150);
      cli.send('Z\r');
      await waitFor(() => output().includes('收到:AZB'), () => `间隔=${gap}ms，输出=${output()}`);
      cli.end('/exit\n');
      const result = await cli.done;
      expect(result.code, `间隔=${gap}ms：${result.stdout}${result.stderr}`).toBe(0);
      expect(model.requests.map(lastUserText), `间隔=${gap}ms`).toEqual(['AZB']);
    }
  });

  it('Esc 判定期内尚未启动的工具等待判定，确认独立 Esc 后不执行', async () => {
    const { cwd, model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '准备调用工具' } },
        // 工具计划在按键判定窗口内启动：若不先等判定，就会在取消生效前执行。
        { delta: { tool_calls: [{ index: 0, id: 'gate-tool', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'touch gate-tool.txt' }) } }] }, delayMs: 120 },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '取消后继续完成' }, { permissions: { allow: ['Bash(touch:*)'] } });
    await waitForPrompt(output);
    cli.send('先输出再调用工具\n');
    await waitFor(() => output().includes('准备调用工具') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    await waitForPrompt(output);
    await sleep(400);
    await expect(readFile(join(cwd, 'gate-tool.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    cli.send('继续下一轮\n');
    await waitFor(() => output().includes('取消后继续完成'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe('继续下一轮');
  });

  it('Esc 判定期内拆包方向键随后到达：等待中的工具照常执行', async () => {
    const { cwd, model, cli, output } = await setup((_request, index) => index === 1
      ? { frames: [
        { delta: { content: '准备调用工具' } },
        // 工具在 [D 到达前已请求启动，判定窗口内必须等待而不是提前取消或放行。
        { delta: { tool_calls: [{ index: 0, id: 'released-tool', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'touch released-tool.txt' }) } }] }, delayMs: 20 },
        { delta: {}, finish_reason: 'tool_calls' },
      ] }
      : { content: '工具放行后完成_MARKER' }, { permissions: { allow: ['Bash(touch:*)'] } });
    await waitForPrompt(output);
    cli.send('先输出再调用工具\n');
    await waitFor(() => output().includes('准备调用工具') && model.requests.length === 1, () => `请求数=${model.requests.length}，输出=${output()}`);

    cli.send('\x1b');
    await sleep(40);
    cli.send('[D');
    await waitFor(() => output().includes('工具放行后完成_MARKER'), () => `输出=${output()}`, 10000);
    await expect(readFile(join(cwd, 'released-tool.txt'), 'utf8')).resolves.toBeDefined();
    expect(output()).not.toContain('用户中断');
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
  });

  it('轮次内已开始的压缩随 Esc 取消，保留压缩前历史并允许继续', async () => {
    const { cwd, userDir, model, cli, output } = await setup(
      (_request, index) => index === 1
        ? { calls: [{ id: 'esc-compact', type: 'function', function: {
          name: 'Bash',
          arguments: JSON.stringify({
            command: 'node -e "const fs=require(\'fs\');const timer=setInterval(()=>{if(fs.existsSync(\'release-compact.txt\')){clearInterval(timer);console.log(\'工具结果_MARKER\');process.exit(0)}},50);setTimeout(()=>{clearInterval(timer);process.exit(1)},5000)"',
          }),
        } }] }
        : { content: '压缩取消后继续完成' },
      { permissions: { allow: ['Bash(node:*)'] } },
      // 摘要请求保持未完成，便于在压缩执行期间发送 Esc。
      () => undefined,
    );
    await waitForPrompt(output);
    cli.send('轮次内压缩需求\n');
    await waitFor(() => output().includes('Bash(') && output().includes('运行中'), () => `输出=${output()}`);
    cli.send('/compact\n');
    await waitFor(() => output().includes('已收到 /compact'), () => `输出=${output()}`);
    await writeFile(join(cwd, 'release-compact.txt'), 'released');
    await waitFor(() => model.summaryRequests.length === 1, () => `摘要请求数=${model.summaryRequests.length}，输出=${output()}`);

    cli.send('\x1b');
    await waitFor(() => output().includes('用户中断'), () => `摘要请求数=${model.summaryRequests.length}，请求数=${model.requests.length}，输出=${output()}`);
    expect(output()).not.toContain('压缩取消后继续完成');
    await waitForPrompt(output);

    cli.send('压缩取消后继续\n');
    await waitFor(() => output().includes('压缩取消后继续完成'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    // 取消轮次不再发起主模型请求；下一轮仍带取消前的用户消息和已完成的工具结果，摘要没有生效。
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).toContain('轮次内压缩需求');
    expect(JSON.stringify(model.requests[1])).toContain('工具结果_MARKER');
    expect(JSON.stringify(model.requests[1])).toContain('压缩取消后继续');
    const record = await readStoredSession(userDir, 'escape');
    expect(record.summaries).toEqual([]);
  });

  it('单独 /compact 时 Esc 不取消，Ctrl+C 取消后返回输入', async () => {
    const { model, cli, output } = await setup(
      (request) => ({ content: `收到:${lastUserText(request)}` }),
      {},
      // 摘要请求保持未完成，便于分别验证 Esc 与 Ctrl+C。
      () => undefined,
    );
    await waitForPrompt(output);
    cli.send('压缩前消息\n');
    await waitFor(() => output().includes('收到:压缩前消息'), () => `输出=${output()}`);
    await waitForPrompt(output);

    cli.send('/compact\n');
    await waitFor(() => model.summaryRequests.length === 1, () => `摘要请求数=${model.summaryRequests.length}，输出=${output()}`);
    cli.send('\x1b');
    // Esc 需要等待按键解析器确认，留出足够时间证明它没有取消压缩。
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(output()).not.toContain('用户中断');
    expect(output()).not.toContain('已压缩当前会话历史');

    cli.send('\x03');
    await waitFor(() => output().includes('用户中断'), () => `输出=${output()}`);
    await waitForPrompt(output);
    cli.send('取消后继续\n');
    await waitFor(() => output().includes('收到:取消后继续'), () => `输出=${output()}`);
    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests).toHaveLength(2);
  });

  it('空闲时 Esc 保留草稿与光标，方向键仍可编辑', async () => {
    const { model, cli, output } = await setup((request) => ({ content: `收到:${lastUserText(request)}` }));
    await waitForPrompt(output);

    cli.send('草稿');
    await new Promise((resolve) => setTimeout(resolve, 100));
    cli.send('\x1b');
    // 单独 Esc 需要等待终端按键解析器确认没有后续转义序列。
    await new Promise((resolve) => setTimeout(resolve, 700));
    cli.send('X\r');
    await waitFor(() => output().includes('收到:草稿X'), () => `输出=${output()}`);
    await waitForPrompt(output);

    await new Promise((resolve) => setTimeout(resolve, 100));
    cli.send('AB');
    await new Promise((resolve) => setTimeout(resolve, 100));
    cli.send('\x1b[D');
    await new Promise((resolve) => setTimeout(resolve, 100));
    cli.send('Z\r');
    await waitFor(() => output().includes('收到:AZB'), () => `输出=${output()}`);

    cli.end('/exit\n');
    const result = await cli.done;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.requests.map(lastUserText)).toEqual(['草稿X', 'AZB']);
  });
});
