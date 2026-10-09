import {
  VAULT_LOCKED_FOLDER_MESSAGE,
  VAULT_LOCKED_NOTE_MESSAGE
} from '@memry/contracts/vault-locks-api'
import { OUTSIDE_VAULT_MESSAGE_SUFFIX, OutsideVaultError } from '../../lib/errors'

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

/**
 * A refusal the agent reports as a permission error: the fixed lock text, or the
 * OutsideVaultError text, which may arrive as a plain string from the renderer.
 */
export function isVaultRefusalMessage(message: string): boolean {
  return (
    message === VAULT_LOCKED_NOTE_MESSAGE ||
    message === VAULT_LOCKED_FOLDER_MESSAGE ||
    message.endsWith(OUTSIDE_VAULT_MESSAGE_SUFFIX)
  )
}

export function toAgentToolError(err: unknown): AgentToolError {
  if (err instanceof AgentToolError) return err
  if (
    err instanceof OutsideVaultError ||
    (err instanceof Error && isVaultRefusalMessage(err.message))
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
