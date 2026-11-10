import { createMCPClient } from '@ai-sdk/mcp';
import type { MCPClient, ListToolsResult } from '@ai-sdk/mcp';
import { jsonSchema } from 'ai';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { ResolvedConfig } from '../settings/config.js';
import { AgentError } from '../../utils/errors.js';
import { ToolExecutionError } from '../../tools/tool-registry.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';

// 每轮新建连接与定义快照；不订阅工具变更，也不注入服务端 instructions。
export async function registerRemoteMCP(config: ResolvedConfig, registry: ToolRegistry, signal: AbortSignal) {
  const clients: MCPClient[] = [];
  const close = async () => { await Promise.allSettled(clients.map((client) => client.close())); };
  try {
    for (const server of config.mcp?.servers ?? []) {
      signal.throwIfAborted();
      let client: MCPClient | undefined;
      let definitions: ListToolsResult;
      try {
        client = await createMCPClient({
          transport: {
            type: 'http', url: server.url, headers: config.mcpHeaders?.[server.name] ?? {},
            // 不允许远端工具参数覆盖连接器配置的认证头。
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              for (const [name, value] of Object.entries(config.mcpHeaders?.[server.name] ?? {})) headers.set(name, value);
              return fetch(input, { ...init, headers, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]), redirect: 'error' });
            },
            terminateSessionOnClose: false,
          },
          maxRetries: 0,
          initializationOptions: { signal, timeout: config.mcp?.connectTimeoutMs ?? 10_000 },
          onUncaughtError: () => { /* 不输出可能携带凭据或远端结果的原始异常。 */ },
        });
        clients.push(client);
        const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(config.mcp?.discoveryTimeoutMs ?? 10_000)]);
        const tools: ListToolsResult['tools'] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          discoverySignal.throwIfAborted();
          const page = await client.listTools({
            ...(cursor === undefined ? {} : { params: { cursor } }), options: { signal: discoverySignal },
          });
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor !== undefined && cursors.has(cursor)) throw new Error('Repeated cursor');
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        definitions = structuredClone({ tools });
      } catch {
        signal.throwIfAborted();
        // 服务故障只影响该服务；固定文本防止原始异常进入日志。
        process.stderr.write(`MCP 服务 ${server.name} 连接或工具发现失败，本轮不可用。\n`);
        continue;
      }

      const schemas: Record<string, { inputSchema: ReturnType<typeof jsonSchema> }> = Object.create(null);
      const names = new Map<string, string>();
      for (const definition of definitions.tools) {
        const suffix = /^[A-Za-z0-9_-]+$/.test(definition.name) ? definition.name : Buffer.from(definition.name).toString('hex');
        const name = `mcp_${server.name}_${suffix}`;
        if (name.length > 64 || names.has(name) || Object.hasOwn(schemas, definition.name)) {
          throw new AgentError('CONFIG_ERROR', 'MCP 工具名称冲突或过长，无法注册本轮工具。');
        }
        names.set(name, definition.name);
        // SDK 的自动 JSON Schema 适配不执行本地校验，补充同一份 schema 的验证器。
        let validate;
        try {
          if (definition.inputSchema.$async) throw new Error('Unsupported async schema');
          const dialect = definition.inputSchema.$schema;
          const Validator = typeof dialect !== 'string' || dialect.includes('2020-12') ? Ajv2020
            : dialect.includes('2019-09') ? Ajv2019 : Ajv;
          validate = new Validator({ strict: false, validateFormats: false, logger: false }).compile(definition.inputSchema);
        } catch {
          throw new AgentError('CONFIG_ERROR', 'MCP 工具参数 schema 不受支持，无法注册本轮工具。');
        }
        schemas[definition.name] = { inputSchema: jsonSchema(definition.inputSchema, {
          validate: (value) => validate(value)
            ? { success: true, value }
            : { success: false, error: new Error('MCP 工具参数无效。') },
        }) };
      }
      const adapted = client.toolsFromDefinitions(definitions, { schemas });
      for (const [name, remoteName] of names) {
        const remote = adapted[remoteName]!;
        registry.register({
          name, description: typeof remote.description === 'string' ? remote.description : '远程 MCP 工具。', inputSchema: remote.inputSchema,
          approvalDetails: { mcpServer: server.name, mcpTool: remoteName },
          execute: async (input, execution) => {
            signal.throwIfAborted();
            const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.mcp?.callTimeoutMs ?? 30_000)]);
            try {
              const result = await remote.execute(input, { ...execution, abortSignal: callSignal });
              if ('isError' in result && result.isError) throw new ToolExecutionError('远程 MCP 工具报告执行失败。', result);
              return result;
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof ToolExecutionError) throw error;
              throw new Error('远程 MCP 调用失败；已发送的操作可能产生副作用，不会自动重试或回滚。');
            }
          },
        });
      }
    }
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
