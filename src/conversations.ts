import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { AgentError } from './errors.js';

const conversationIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export function newConversationId(): string {
  return randomUUID();
}

function conversationPath(directory: string, conversationId: string): string {
  if (!conversationIdPattern.test(conversationId)) {
    throw new AgentError('CONFIG_ERROR', 'conversationId 仅允许 1–128 位字母、数字、下划线或连字符。');
  }
  return join(directory, `${conversationId}.json`);
}

export async function loadConversation(
  directory: string,
  conversationId: string,
): Promise<ModelMessage[]> {
  const path = conversationPath(directory, conversationId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw new AgentError('PROVIDER_ERROR', '无法读取会话历史。');
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isModelMessage)) throw new Error('Invalid history');
    return parsed;
  } catch {
    throw new AgentError('PROVIDER_ERROR', '会话历史文件格式无效，未发送模型请求。');
  }
}

export async function saveConversation(
  directory: string,
  conversationId: string,
  messages: ModelMessage[],
): Promise<void> {
  const path = conversationPath(directory, conversationId);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(directory, `.${conversationId}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(messages), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } catch {
    throw new AgentError('PROVIDER_ERROR', '无法保存会话历史。');
  }
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (typeof value !== 'object' || value === null || !('role' in value) || !('content' in value)) return false;
  return value.role === 'system'
    || value.role === 'developer'
    || value.role === 'user'
    || value.role === 'assistant'
    || value.role === 'tool';
}
