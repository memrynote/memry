import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { createLogger } from '../lib/logger'
import { getMeta, setMeta, openVaultDb } from '../db/index'
import { getSyncEngine } from './engine'

const log = createLogger('FirstSync')

const FIRST_SYNC_DONE_KEY = 'first_sync.completed'
const BODY_WINDOW_DAYS = 30
const BLOB_CHUNK = 100

export interface FirstSyncProgress {
  phase: 'refs' | 'metadata' | 'recent-bodies' | 'done'
  /** 0..1, determinate (FR-008). */
  fraction: number
  itemsTotal: number
  itemsPulled: number
}

/**
 * Windowed first sync (T047): the app is usable while it runs and progress is
 * determinate.
 *
 * Phase A (`refs`): walk the whole change feed storing refs only — cheap, and
 * durable before the cursor moves, so a kill mid-run resumes without loss.
 * Phase B (`metadata`): pull every non-note blob plus every note/journal blob
 * (titles and folders live in the encrypted payload — the notes list needs
 * them all), most-recently-modified first.
 * Phase C (`recent-bodies`): CRDT bodies for notes touched in the last 30
 * days. Older bodies stay `metadata-only` and arrive on demand (T048).
 */
export async function runFirstSyncIfNeeded(
  vaultId: string,
  onProgress: (progress: FirstSyncProgress) => void
): Promise<boolean> {
  const db = await openVaultDb(vaultId)
  if ((await getMeta(db, FIRST_SYNC_DONE_KEY)) === '1') return false

  const engine = getSyncEngine(vaultId)
  const store = await engine.getStore()
  if (!store) throw new Error('Vault is locked; unlock before first sync')

  onProgress({ phase: 'refs', fraction: 0, itemsTotal: 0, itemsPulled: 0 })
  const totalRefs = await engine.pullRefsToEnd()
  log.info('First sync refs recorded', { totalRefs })

  const allTypes = [...RECORD_SYNC_ITEM_TYPES]
  let pulled = 0
  const recentNoteIds = new Set<string>()
  const windowStart = Date.now() - BODY_WINDOW_DAYS * 24 * 60 * 60 * 1000

  // Metadata phase: everything, newest first, in protocol-sized chunks. On a
  // resumed run totalRefs is 0 (cursor already at the end) while rows from
  // the interrupted attempt still sit metadata-only — count those in.
  const missingAtStart = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_items WHERE payload_state = 'metadata-only' AND deleted_at IS NULL`
  )
  const totalToPull = Math.max(totalRefs, missingAtStart?.n ?? 0)

  // Ids the server would not return or that failed decrypt: skipped, never
  // looped on — an unpullable chunk must not wedge the whole first sync. A
  // chunk that THROWS is bisected instead of aborting the run, so one bad
  // batch (or a native hiccup at a given batch size) costs at most its own
  // ids, logged loudly.
  const unpullable = new Set<string>()
  for (;;) {
    const candidates = await store.listItemIdsMissingPayload(allTypes, BLOB_CHUNK + unpullable.size)
    const first = candidates.filter((id) => !unpullable.has(id)).slice(0, BLOB_CHUNK)
    if (first.length === 0) break

    const queue: string[][] = [first]
    while (queue.length > 0) {
      const ids = queue.shift() as string[]
      try {
        const result = await engine.pullBlobs(ids)
        pulled += result.applied
        for (const noteId of result.changedNoteIds) recentNoteIds.add(noteId)
      } catch (err) {
        if (ids.length > 5) {
          const mid = Math.ceil(ids.length / 2)
          queue.push(ids.slice(0, mid), ids.slice(mid))
          log.warn('First sync chunk threw; bisecting', {
            size: ids.length,
            error: err instanceof Error ? err.message : String(err)
          })
        } else {
          for (const id of ids) unpullable.add(id)
          log.warn('First sync mini-chunk threw; ids skipped this run', {
            ids: ids.length,
            error: err instanceof Error ? err.message : String(err)
          })
        }
        continue
      }

      // Whatever this chunk left metadata-only is unpullable for this run.
      const placeholders = ids.map(() => '?').join(',')
      const stillMissing = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM sync_items WHERE payload_state = 'metadata-only' AND id IN (${placeholders})`,
        ids
      )
      for (const row of stillMissing) unpullable.add(row.id)

      onProgress({
        phase: 'metadata',
        fraction: Math.min(0.8, (pulled / Math.max(totalToPull, 1)) * 0.8),
        itemsTotal: totalToPull,
        itemsPulled: pulled
      })
    }
  }
  if (unpullable.size > 0) {
    log.warn('First sync finished with unpullable items; on-demand fetch retries them', {
      count: unpullable.size
    })
  }

  // Recent-bodies phase: only the 30-day window pays the CRDT cost up front.
  const recentRows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL AND updated_at >= ?
     ORDER BY updated_at DESC`,
    [windowStart]
  )
  const bodyIds = recentRows.map((r) => r.id)
  onProgress({ phase: 'recent-bodies', fraction: 0.8, itemsTotal: totalRefs, itemsPulled: pulled })
  const bodies = await engine.pullBodiesFor(store, bodyIds)
  log.info('First sync recent bodies pulled', { requested: bodyIds.length, updated: bodies })

  await setMeta(db, FIRST_SYNC_DONE_KEY, '1')
  await setMeta(db, 'first_sync.window_start', String(windowStart))
  onProgress({ phase: 'done', fraction: 1, itemsTotal: totalRefs, itemsPulled: pulled })
  return true
}
