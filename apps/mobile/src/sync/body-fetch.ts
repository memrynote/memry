import { openVaultDb } from '../db/index'
import { createLogger } from '../lib/logger'
import { getSyncEngine } from './engine'

const log = createLogger('BodyFetch')

/**
 * On-demand body fetch (T048): opening a note whose row is still
 * `metadata-only` (outside the 30-day window) pulls its record blob and CRDT
 * body right then. `payload_state` only ever moves metadata-only → full.
 */
export async function ensureNoteBody(vaultId: string, noteId: string): Promise<boolean> {
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
    if (!store) return false
    const updated = await engine.pullBodiesFor(store, [noteId])
    return updated > 0
  } catch (err) {
    log.warn('On-demand body fetch failed', {
      noteId,
      error: err instanceof Error ? err.message : String(err)
    })
    return false
  }
}
