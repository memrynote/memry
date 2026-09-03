import type { ToolCallStatus } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import type { MessageStore } from '../storage/message-store'

const logger = createLogger('AgentRuntime:ToolActivity')

// A tool row is a record of what the agent did, not a copy of what it moved.
// Args can carry a whole note body (`vault_update_note`) and results can carry
// a whole search response, so only the identifying scalars are kept, each one
// bounded. Nested payloads are dropped and the tool output is never stored.
const MAX_ARG_KEYS = 12
const MAX_ARG_CHARS = 200
const MAX_ERROR_CHARS = 500

export type ToolActivityOutcome =
  { ok: true } | { ok: false; error: { code: string; message: string } | undefined }

/**
 * Reduces raw tool args to the small, bounded shape the transcript row renders:
 * the scalars that name what was touched (`title`, `path`, `query`, ids), with
 * long strings truncated and nested payloads dropped.
 */
export function summarizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}

  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (Object.keys(summary).length >= MAX_ARG_KEYS) break
    if (typeof value === 'string') {
      summary[key] = value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…` : value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value
    }
  }
  return summary
}

function toolStatusFor(outcome: ToolActivityOutcome): ToolCallStatus {
  if (outcome.ok) return 'output-available'
  return outcome.error?.code === 'PERMISSION_DENIED' ? 'output-denied' : 'output-error'
}

/**
 * Writes a settled tool call into the conversation so the transcript still
 * shows what the agent did after the renderer drops it — on eviction, on a
 * sync-driven reload, or on the next app start.
 *
 * The id matches the one the renderer synthesises for the live row, so the
 * reloaded transcript renders the same row rather than a second copy.
 *
 * Only settled calls are written: a row appended at `tool_use` time would be
 * left mid-flight forever if the turn died before the result, and reload it
 * as a tool that is still spinning.
 *
 * Never throws. A transcript record is not worth failing a turn the user's
 * agent already completed.
 */
export function persistToolActivity(
  messages: MessageStore,
  input: {
    conversationId: string
    toolCallId: string
    name: string
    args: unknown
    outcome: ToolActivityOutcome
  }
): void {
  try {
    const error = input.outcome.ok ? undefined : input.outcome.error
    messages.append({
      id: `tool-call-${input.toolCallId}`,
      conversationId: input.conversationId,
      role: 'tool_call',
      content: {
        role: 'tool_call',
        data: {
          tool: input.name,
          args: summarizeToolArgs(input.args),
          status: toolStatusFor(input.outcome),
          ...(error && {
            error: { code: error.code, message: error.message.slice(0, MAX_ERROR_CHARS) }
          })
        }
      },
      toolCallId: input.toolCallId,
      attachments: [],
      status: input.outcome.ok ? 'completed' : 'error'
    })
  } catch (error) {
    logger.warn('Failed to persist tool activity row', error)
  }
}
