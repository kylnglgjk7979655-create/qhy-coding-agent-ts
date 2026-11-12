import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'qhy-midscene-'));
await mkdir(join(dir, 'home'));
await writeFile(join(dir, 'note.txt'), '文件内容\n');
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
    const last = messages.at(-1);
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    if (prompt.includes('故障')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture failure' } }));
      return;
    }
    let call;
    if (last?.role !== 'tool' && prompt.includes('读取文件')) call = ['read_file', { path: 'note.txt' }];
    if (last?.role !== 'tool' && prompt.includes('批准写入')) call = ['write_file', { path: 'approved.txt', content: 'approved-content' }];
    if (last?.role !== 'tool' && prompt.includes('拒绝写入')) call = ['write_file', { path: 'denied.txt', content: 'denied-content' }];
    const delta = call
      ? { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { content: last?.role === 'tool' ? '工具处理完成。' : '固定回复：测试成功。' };
    const chunk = (part, finish) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'qa-fixture', choices: [{ index: 0, delta: part, finish_reason: finish }] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify({ ...chunk({}, call ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  } catch {
    res.writeHead(500); res.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();
await writeFile(join(dir, 'agent.config.json'), JSON.stringify({ model: 'qa-fixture', apiKeyEnv: 'TEST_MODEL_API_KEY', baseURL: `http://127.0.0.1:${port}/v1`, workspace: '.', timeoutMs: 10000, maxSteps: 20, approval: { mode: 'human', humanTimeoutMs: 300000 } }));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`测试目录：${dir}`);
console.log(`在前台终端运行：cd ${quote(dir)} && HOME=$PWD/home USERPROFILE=$PWD/home TEST_MODEL_API_KEY=test ${quote(process.execPath)} ${quote(resolve('dist/cli.js'))} --workspace .`);
console.log('结束后检查 approved.txt 内容为 approved-content 且 denied.txt 不存在；Ctrl+C 停止夹具。');
