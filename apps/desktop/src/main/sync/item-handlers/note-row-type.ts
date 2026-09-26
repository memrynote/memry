import { createLogger } from '../../lib/logger'

const log = createLogger('NoteRowType')

type NoteRowType = 'note' | 'journal'

const warned = new Set<string>()

/**
 * Notes and journals share `note_metadata`, keyed by id alone, while the server
 * keeps one row per (type, id). A legacy-id journal tombstone and a live note
 * with the same id both come back on every pull, so each handler can be handed
 * the other type's row. True when `row` is the other type's: the caller must
 * leave the row, its CRDT doc and its file alone.
 */
export function belongsToOtherType(
  itemId: string,
  incomingType: NoteRowType,
  row: { journalDate: string | null }
): boolean {
  const localType: NoteRowType = row.journalDate ? 'journal' : 'note'
  if (localType === incomingType) return false

  // Every pull returns both server rows again; one line per id is enough.
  const key = `${incomingType}:${itemId}`
  if (!warned.has(key)) {
    warned.add(key)
    log.warn('Skipping remote item whose id belongs to a local item of another type', {
      itemId,
      incomingType,
      localType
    })
  }
  return true
}
