import {
  VAULT_LOCKED_FOLDER_MESSAGE,
  VAULT_LOCKED_NOTE_MESSAGE
} from '@memry/contracts/vault-locks-api'

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

/** A refusal because the owner locked the target: the fixed lock text, as a permission error. */
export function isVaultLockRefusalMessage(message: string): boolean {
  return message === VAULT_LOCKED_NOTE_MESSAGE || message === VAULT_LOCKED_FOLDER_MESSAGE
}

export function toMcpToolErrorContent(err: unknown): McpErrorContent {
  const tool =
    err instanceof AgentToolError
      ? { code: err.code, message: err.message, details: err.details }
      : err instanceof Error && isVaultLockRefusalMessage(err.message)
        ? { code: 'PERMISSION_DENIED' as const, message: err.message, details: undefined }
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
