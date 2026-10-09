/**
 * One journal item per day (protocol §1.9.1, #2939).
 *
 * A journal item whose id is not its day's `j<date>` is foreign. The pull never
 * projects it (`journalHandler.applyUpsert`); it owes a merge here instead. The
 * drain, run after the pull's body pass, folds the foreign body into the day's
 * doc as a local edit (stored, written back, pushed) and then tombstones the
 * foreign id. Every step converges when repeated: the same Yjs items merge
 * once, and a tombstone upserts by (type, id).
 *
 * Owed merges live in `sync_state`, so no migration is needed and an older
 * build ignores the keys.
 */
import { eq, like } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { generateJournalId } from '@memry/contracts/journal-api'
import type { VectorClock } from '@memry/contracts/sync-api'
import { incrementClock } from '@memry/sync-core'
import { recordDeclinedRef } from '@memry/sync-client/declined-refs'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { getNoteMetadataById } from '@memry/storage-data'
import { createLogger } from '../lib/logger'
import { createJournalEntry } from '../journal/create-entry'
import { relinkTasksToMergedNote } from '../notes/runtime-effects'
import { getCrdtProvider } from './crdt-provider'
import { getJournalSyncService } from './journal-sync'
import { recordPendingDelete } from './pending-deletes'

const log = createLogger('JournalDayMerge')

const KEY_PREFIX = 'journalDayMerge:'

export interface OwedJournalDayMerge {
  foreignId: string
  date: string
  /** The foreign item's clock; its tombstone happens strictly after it. Null when it never synced. */
  clock: VectorClock | null
  /**
   * The day file's body when a local foreign row gave the day up. Used only
   * when that row's doc holds nothing: the text lives on this device alone, so
   * minting items for it cannot duplicate on another device.
   */
  fallbackMarkdown?: string | null
  /** The foreign id's tombstone arrived: another device merged it already. */
  deleted?: boolean
}

/**
 * Record that `foreignId`'s body belongs to `date`'s entry. Declining the ref
 * keeps the manifest from counting the unprojected id as server-only, which
 * would reset the cursor on every check.
 */
export function oweJournalDayMerge(db: DrizzleDb, merge: OwedJournalDayMerge): void {
  const kept = listOwedJournalDayMerges(db).find((owed) => owed.foreignId === merge.foreignId)
  const fallbackMarkdown = merge.fallbackMarkdown ?? kept?.fallbackMarkdown
  const value = JSON.stringify(fallbackMarkdown ? { ...merge, fallbackMarkdown } : merge)
  db.insert(syncState)
    .values({ key: KEY_PREFIX + merge.foreignId, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } })
    .run()
  recordDeclinedRef(db, { type: 'journal', id: merge.foreignId })
}

/**
 * A tombstone for an owed id means another device merged and deleted it. What
 * this device holds of its body still merges, but it owes no tombstone, and an
 * empty body no longer keeps it owed.
 */
export function markOwedJournalDayMergeDeleted(db: DrizzleDb, foreignId: string): void {
  const owed = listOwedJournalDayMerges(db).find((merge) => merge.foreignId === foreignId)
  if (!owed || owed.deleted) return
  db.update(syncState)
    .set({ value: JSON.stringify({ ...owed, deleted: true }), updatedAt: new Date() })
    .where(eq(syncState.key, KEY_PREFIX + foreignId))
    .run()
}

export function listOwedJournalDayMerges(db: DrizzleDb): OwedJournalDayMerge[] {
  return db
    .select({ value: syncState.value })
    .from(syncState)
    .where(like(syncState.key, `${KEY_PREFIX}%`))
    .all()
    .flatMap((row) => {
      try {
        return [JSON.parse(row.value) as OwedJournalDayMerge]
      } catch (error) {
        log.warn('Dropping an unreadable owed journal merge', { error })
        return []
      }
    })
}

export interface JournalDayMergeDeps {
  db: DrizzleDb
  deviceId: string
  /** Creates the day's entry, empty, when no row holds it. */
  ensureDay: (date: string) => Promise<void>
  /** Merges the server's body for `id` into its local doc. False when it is not fully merged. */
  pullBody: (id: string) => Promise<boolean>
  /**
   * Folds `foreignId`'s doc into `targetId`'s as a local edit, building the
   * foreign doc from `fallbackMarkdown` when it is empty. False when there is
   * nothing to fold.
   */
  absorbBody: (
    targetId: string,
    foreignId: string,
    fallbackMarkdown: string | null
  ) => Promise<boolean>
  /** Points the foreign id's task links at the day. */
  relinkTasks: (fromId: string, toId: string) => Promise<void>
  purgeDoc: (id: string) => Promise<void>
  enqueueDelete: (id: string, payload: string) => void
}

/** Log fields: never the fallback text, which is the user's journal. */
function describe(merge: OwedJournalDayMerge): { foreignId: string; date: string } {
  return { foreignId: merge.foreignId, date: merge.date }
}

export async function drainJournalDayMerges(deps: JournalDayMergeDeps): Promise<number> {
  let settled = 0
  for (const merge of listOwedJournalDayMerges(deps.db)) {
    try {
      if (await mergeOne(deps, merge)) settled++
    } catch (error) {
      log.warn('Journal day merge failed; it stays owed', { ...describe(merge), error })
    }
  }
  return settled
}

async function mergeOne(deps: JournalDayMergeDeps, merge: OwedJournalDayMerge): Promise<boolean> {
  const targetId = generateJournalId(merge.date)
  await deps.ensureDay(merge.date)
  // A deleted id's server body is already in the day, merged by the device
  // that deleted it; only what this device holds is left to fold in.
  if (!merge.deleted && !(await deps.pullBody(merge.foreignId))) {
    log.info('Foreign journal body not fully pulled; merge stays owed', describe(merge))
    return false
  }
  // No Yjs body to merge. Its text cannot be carried without minting new
  // items, which two devices would each do, so a live id stays owed and
  // visible in the log rather than being tombstoned with its text.
  const absorbed = await deps.absorbBody(targetId, merge.foreignId, merge.fallbackMarkdown ?? null)
  if (!absorbed && !merge.deleted) {
    log.warn('Foreign journal has no body to merge; leaving it owed', describe(merge))
    return false
  }
  await deps.relinkTasks(merge.foreignId, targetId)

  if (merge.clock && !merge.deleted) {
    const payload = JSON.stringify({ clock: incrementClock(merge.clock, deps.deviceId) })
    recordPendingDelete(deps.db, 'journal', merge.foreignId, payload)
    deps.enqueueDelete(merge.foreignId, payload)
  }
  await deps.purgeDoc(merge.foreignId)
  deps.db
    .delete(syncState)
    .where(eq(syncState.key, KEY_PREFIX + merge.foreignId))
    .run()
  log.info('Merged a foreign journal into its day', { ...describe(merge), targetId })
  return true
}

/** The pull's drain: `pullBody` is the run's single-document body pull. */
export async function runJournalDayMerges(
  db: DrizzleDb,
  pullBody: (id: string) => Promise<boolean>
): Promise<void> {
  if (listOwedJournalDayMerges(db).length === 0) return
  const deviceId = getCurrentDeviceId(db)
  const journalSync = getJournalSyncService()
  if (!deviceId || !journalSync) return
  const provider = getCrdtProvider()
  await drainJournalDayMerges({
    db,
    deviceId,
    ensureDay: async (date) => {
      if (getNoteMetadataById(db, generateJournalId(date))) return
      await createJournalEntry({ date, content: '' })
    },
    pullBody,
    absorbBody: (targetId, foreignId, fallbackMarkdown) =>
      provider.absorbForeignDoc(targetId, foreignId, fallbackMarkdown),
    relinkTasks: relinkTasksToMergedNote,
    purgeDoc: (id) => provider.purge(id),
    enqueueDelete: (id, payload) => journalSync.enqueueRecoveredDelete(id, payload)
  })
}
