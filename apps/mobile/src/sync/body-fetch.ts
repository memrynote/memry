import { openVaultDb } from '../db/index'
import { createLogger } from '../lib/logger'
import { getSyncEngine } from './engine'

const log = createLogger('BodyFetch')

/**
 * On-demand body fetch (T048): opening a note whose row is still
 * `metadata-only` (outside the 30-day window) pulls its record blob and CRDT
 * body right then. `payload_state` only ever moves metadata-only → full.
 */
export type BodyFetchOutcome =
  | 'updated'
  /** The pull completed and the server had no CRDT state for this note. */
  | 'empty'
  /** Offline, locked, or the request failed — the server's state is UNKNOWN. */
  | 'failed'

/**
 * Tri-state on purpose. A boolean collapses "the server has nothing" and "we
 * could not ask", and the editor's seed decision turns on exactly that
 * distinction: seeding on the first is correct, seeding on the second
 * duplicates a body the server already holds, on every device, permanently.
 */
export async function ensureNoteBody(vaultId: string, noteId: string): Promise<BodyFetchOutcome> {
  const db = await openVaultDb(vaultId)
  const engine = getSyncEngine(vaultId)

  const row = await db.getFirstAsync<{ payload_state: string }>(
    'SELECT payload_state FROM sync_items WHERE id = ?',
    [noteId]
  )

  try {
    if (row?.payload_state !== 'full') {
      await engine.pullBlobs([noteId])
    }
    const store = await engine.getStore()
    // No store means a locked vault or no session: we did not ask.
    if (!store) return 'failed'
    const updated = await engine.pullBodiesFor(store, [noteId])
    return updated > 0 ? 'updated' : 'empty'
  } catch (err) {
    log.warn('On-demand body fetch failed', {
      noteId,
      error: err instanceof Error ? err.message : String(err)
    })
    return 'failed'
  }
}
