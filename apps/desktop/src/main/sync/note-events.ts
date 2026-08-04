import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'

/**
 * Both emit paths in this package are `(channel: string, data: unknown)`, so
 * the renderer-side contract is invisible to typecheck here. Every
 * `notes:updated` emit from the sync path goes through this helper instead, so
 * the payload is checked against `NoteUpdatedEvent` at the call site.
 *
 * Why it matters: renderer subscribers dereference `event.changes` without
 * guarding (`use-notes-query.ts` reads `changes.content` for every note that
 * is not the open one), so an emit that omits `changes` throws once per pulled
 * note and the subscriber silently misses the event.
 */
export function emitNoteUpdated(
  emit: (channel: string, data: unknown) => void,
  event: NoteUpdatedEvent
): void {
  emit(NotesChannels.events.UPDATED, event)
}
