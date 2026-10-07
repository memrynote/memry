import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'

import { readBackFailedWarning } from './desktop-api-readback'
import type { VaultServiceHandles, WrittenBody } from './handles'

/**
 * The record a read returns after the write, or only the id when none reads
 * back. The write has landed by then, so a failed read adds a warning instead
 * of failing the call; a retry would write twice.
 */
export async function afterWrite<R, T extends object>(
  read: () => Promise<R | null | undefined>,
  reply: T
): Promise<R | T | (T & { warnings: string[] })> {
  try {
    return (await read()) ?? reply
  } catch (error) {
    return { ...reply, warnings: [readBackFailedWarning(error)] }
  }
}

export function storedNoteReply(handles: VaultServiceHandles, id: string) {
  return afterWrite(() => handles.notes.stored(id), { id })
}

export function tagChanges(before: string[], after: string[]) {
  return {
    tags_added: after.filter((tag) => !before.includes(tag)),
    tags_removed: before.filter((tag) => !after.includes(tag))
  }
}

export const CRDT_STORE_UNAVAILABLE =
  'The CRDT store is unavailable on this device, so note edits sync without merge history ' +
  'this session. Read changed notes back to check what was stored.'

function comparableBody(body: string): string {
  return body.replace(/(\r?\n)+$/, '')
}

/**
 * Says so when the stored body is not the one sent (#2615). Line endings count,
 * so an LF body stored in a CRLF file is reported; only the final newline the
 * file adds does not.
 */
export function bodyWarnings(body: WrittenBody | undefined): string[] {
  if (!body || body.stored === null) return []
  if (comparableBody(body.sent) === comparableBody(body.stored)) return []
  return [
    'The stored body is not the body this write sent. ' +
      `Sent ${Buffer.byteLength(body.sent)} bytes, stored ${Buffer.byteLength(body.stored)} bytes. ` +
      'Read it back to see what was stored.'
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The note and body a desktop API note write sent, when it sent one:
 * `notes.update` names the note in its input, `notes.create` in its reply.
 */
export function desktopNoteWrite(
  operation: AgentMcpDesktopWriteOperation,
  args: unknown[],
  result: unknown
): { id: string; sent: string } | null {
  const input = args[0]
  if (!isRecord(input) || typeof input.content !== 'string') return null
  if (operation === 'notes.update' && typeof input.id === 'string') {
    return { id: input.id, sent: input.content }
  }
  const note = isRecord(result) ? result.note : undefined
  if (operation === 'notes.create' && isRecord(note) && typeof note.id === 'string') {
    return { id: note.id, sent: input.content }
  }
  return null
}

/** A desktop API note reply whose `note.content` is what was stored, not what was sent. */
export function withStoredNoteContent(result: unknown, stored: string | null): unknown {
  if (stored === null || !isRecord(result) || !isRecord(result.note)) return result
  return { ...result, note: { ...result.note, content: stored } }
}

/**
 * `result` with `warnings` added as its first key, so a reply the size cap cuts
 * still starts with them. A result that is not a plain object, or whose
 * `warnings` is not a list of strings, is wrapped as `{ warnings, result }`.
 */
export function withWarnings(result: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return result
  if (!isRecord(result)) return { warnings, result }
  const { warnings: existing, ...rest } = result
  if (existing === undefined) return { warnings, ...rest }
  if (Array.isArray(existing) && existing.every((w) => typeof w === 'string')) {
    return { warnings: [...existing, ...warnings], ...rest }
  }
  return { warnings, result }
}
