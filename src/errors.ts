import { APICallError, ToolChoiceViolationError } from 'ai';

export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'AUTH_ERROR'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'TOOL_COMPATIBILITY_ERROR'
  | 'STEP_LIMIT'
  | 'CANCELLED'
  | 'APPROVAL_ERROR'
  | 'CONTEXT_ERROR'
  | 'INTERNAL_ERROR';

const exitCodes: Record<ErrorCode, number> = {
  CONFIG_ERROR: 2,
  APPROVAL_ERROR: 8,
  CONTEXT_ERROR: 9,
  AUTH_ERROR: 3,
  TIMEOUT: 4,
  PROVIDER_ERROR: 5,
  TOOL_COMPATIBILITY_ERROR: 6,
  STEP_LIMIT: 7,
  CANCELLED: 130,
  INTERNAL_ERROR: 1,
};

export class AgentError extends Error {
  readonly exitCode: number;

  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
    this.exitCode = exitCodes[code];
  }
}

// Provider exceptions can contain request headers, response bodies and keys.
// Only publish our own messages, never the raw exception or its stack.
export function publicError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (ToolChoiceViolationError.isInstance(error)) {
    return new AgentError('TOOL_COMPATIBILITY_ERROR', '模型未遵守工具调用要求，请检查模型和 provider 的工具兼容性。');
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new AgentError('AUTH_ERROR', '模型鉴权失败，请检查凭据、项目权限和服务地址。');
    }
    if (error.statusCode === 408 || error.statusCode === 504) {
      return new AgentError('TIMEOUT', '模型请求超时，请检查网络或增大 timeoutMs。');
    }
    return new AgentError(
      'PROVIDER_ERROR',
      error.statusCode === undefined
        ? '无法连接模型服务，请检查网络和 baseURL。'
        : `模型服务返回 HTTP ${error.statusCode}，请检查模型、配额和工具调用支持。`,
    );
  }
  return new AgentError('INTERNAL_ERROR', '运行失败，请检查配置及模型服务的兼容性。');
}
