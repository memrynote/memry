import { VAULT_LOCKED_NOTE_MESSAGE } from '@memry/contracts/vault-locks-api'
import { OutsideVaultError } from '../../lib/errors'

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
  return message === VAULT_LOCKED_NOTE_MESSAGE
}

export function toAgentToolError(err: unknown): AgentToolError {
  if (err instanceof AgentToolError) return err
  if (
    err instanceof OutsideVaultError ||
    (err instanceof Error && isVaultLockRefusalMessage(err.message))
  ) {
    return new AgentToolError('PERMISSION_DENIED', err.message)
  }
  return new AgentToolError('INTERNAL', err instanceof Error ? err.message : String(err))
}

export function toMcpToolErrorContent(err: unknown): McpErrorContent {
  const { code, message, details } = toAgentToolError(err)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, details }) }]
  }
}
