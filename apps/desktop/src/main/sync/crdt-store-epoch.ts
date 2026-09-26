/**
 * Ties the snapshot claim to the CRDT store that earned it (#2299).
 *
 * A snapshot push claims `coversThrough = LAST_CURSOR`: "the docs hold every
 * note body at or below this cursor". The cursor and the legacy-sweep key live
 * in the data DB; the docs live in the CRDT store. A store quarantined after a
 * failed preflight, created fresh for an existing vault, or restored from a
 * different point in time than the data DB keeps the cursor and loses the
 * merged history, and the claim would then prune peer rows the new docs never
 * held.
 *
 * So the store and the data DB carry one random epoch id each, written
 * together and compared for equality. The two live apart (the store under
 * userData, the data DB in the vault folder) and are backed up, moved and
 * restored apart, so a store older or newer than its data DB, a fresh store,
 * and a data DB from another machine all read as a mismatch. On a mismatch the
 * store is treated as not holding what the data DB says was merged: the legacy
 * sweep key is deleted, which withholds every claim until a sweep has merged
 * the vault again, and `crdtUnmergedDebt` is raised with its mirror marker
 * deleted, which the next sync engine start converts into a whole-body debt
 * for every note (#2297). A new epoch is then written to the data DB first and the store last, so a failed
 * write reads as a mismatch again on the next open.
 *
 * A store written by a build before this marker reads as unmarked, so every
 * existing install runs that sweep once after the upgrade.
 */
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'
import type { CrdtPersistence } from './crdt-persistence'
import { SYNC_STATE_KEYS } from './engine/sync-context'

const log = createLogger('CrdtStoreEpoch')

/** A reserved document name: y-leveldb meta keys never enter the doc list. */
const STORE_MARKER_DOC = '__memry_crdt_store__'
const STORE_MARKER_KEY = 'syncEpoch'

/** Answers whether the epochs differed (and the data DB state was reset). */
export async function reconcileCrdtStoreEpoch(
  persistence: Pick<CrdtPersistence, 'getMeta' | 'setMeta'>,
  db: DataDb
): Promise<boolean> {
  const storeEpoch = await persistence.getMeta(STORE_MARKER_DOC, STORE_MARKER_KEY)
  const dataEpoch = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, SYNC_STATE_KEYS.CRDT_STORE_EPOCH))
    .get()?.value
  if (typeof storeEpoch === 'string' && storeEpoch === dataEpoch) return false

  const epoch = randomUUID()
  const updatedAt = new Date()
  db.transaction((tx) => {
    tx.delete(syncState)
      .where(
        inArray(syncState.key, [
          SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP,
          SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT
        ])
      )
      .run()
    for (const [key, value] of [
      [SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '1'],
      [SYNC_STATE_KEYS.CRDT_STORE_EPOCH, epoch]
    ] as const) {
      tx.insert(syncState)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
        .run()
    }
  })
  await persistence.setMeta(STORE_MARKER_DOC, STORE_MARKER_KEY, epoch)
  log.info(
    'CRDT store epoch does not match the data DB: snapshot claims withheld until the vault is swept'
  )
  return true
}
