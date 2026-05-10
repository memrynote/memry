export type AgentToolErrorCode = 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION' | 'INTERNAL'

export class AgentToolError extends Error {
  readonly code: AgentToolErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: AgentToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AgentToolError'
    this.code = code
    this.details = details
  }
}

export interface McpErrorContent {
  [key: string]: unknown
  isError: true
  content: Array<{ type: 'text'; text: string }>
}

export function toMcpToolErrorContent(err: unknown): McpErrorContent {
  const tool =
    err instanceof AgentToolError
      ? { code: err.code, message: err.message, details: err.details }
      : {
          code: 'INTERNAL' as const,
          message: err instanceof Error ? err.message : String(err),
          details: undefined
        }

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(tool) }]
  }
}
