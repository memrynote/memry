/**
 * One journal item per day (protocol §1.9.1, #2939).
 *
 * A journal item whose id is not its day's `j<date>` is foreign. The pull never
 * projects it (`journalHandler.applyUpsert`); it owes a merge here instead. The
 * drain, run after the pull's body pass, folds the foreign body into the day's
 * doc as a local edit (stored, written back, pushed) and then tombstones the
 * foreign id. Only a merge tombstones: an id this device did not fold stays
 * live, since its text may exist only on a device that never pushed it. Every step converges when repeated: the same Yjs items merge
 * once, and a tombstone upserts by (type, id).
 *
 * Owed merges live in `sync_state`, so no migration is needed and an older
 * build ignores the keys.
 */
import { createHash } from 'crypto'
import { eq, like } from 'drizzle-orm'
import * as Y from 'yjs'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { generateJournalId } from '@memry/contracts/journal-api'
import type { VectorClock } from '@memry/contracts/sync-api'
import { incrementClock } from '@memry/sync-core'
import { planJournalDayMerge } from '@memry/domain-notes/journal'
import { readTombstoneClock, recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { compare as compareClocks, merge as mergeClocks } from '@memry/sync-client/vector-clock'
import { recordDeclinedRef } from '@memry/sync-client/declined-refs'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { deleteNoteMetadata, getNoteMetadataById, getNoteMetadataByPath } from '@memry/storage-data'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database/client'
import { deleteNoteCache, getNoteCacheByPath } from '../database/queries/notes'
import { createJournalEntry } from '../journal/create-entry'
import { getJournalRelativePath, parseJournalEntry, readJournalTextSync } from '../vault/journal'
import { deleteNoteFromCache } from '../vault/note-sync'
import { relinkTasksToMergedNote } from '../notes/runtime-effects'
import { EMPTY_DOC_UPDATE_BYTES, getCrdtProvider } from './crdt-provider'
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
   * The day file's body when a local foreign row gave the day up: this
   * device's text, preferred over `recordMarkdown`.
   */
  fallbackMarkdown?: string | null
  /**
   * The foreign record's `content`. Both build the foreign doc when it holds
   * no Yjs state. Two devices that build at once each mint their own items,
   * so the text can show twice in the day (§1.9.1, known limits).
   */
  recordMarkdown?: string | null
  /** The foreign id's tombstone arrived: another device merged it already. */
  deleted?: boolean
}

/**
 * Record that `foreignId`'s body belongs to `date`'s entry. Idempotent: a
 * second sighting widens the clock, so the tombstone dominates every version
 * seen, and keeps the fallback text and the deleted mark. Declining the ref
 * keeps the manifest from counting the unprojected id as server-only, which
 * would reset the cursor on every check.
 */
export function oweJournalDayMerge(db: DrizzleDb, merge: OwedJournalDayMerge): void {
  const kept = listOwedJournalDayMerges(db).find((owed) => owed.foreignId === merge.foreignId)
  const clock =
    kept?.clock && merge.clock
      ? mergeClocks(kept.clock, merge.clock)
      : (merge.clock ?? kept?.clock ?? null)
  const fallbackMarkdown = merge.fallbackMarkdown ?? kept?.fallbackMarkdown
  const recordMarkdown = merge.recordMarkdown ?? kept?.recordMarkdown
  const deleted = merge.deleted || kept?.deleted
  const value = JSON.stringify({
    ...merge,
    clock,
    ...(fallbackMarkdown ? { fallbackMarkdown } : {}),
    ...(recordMarkdown ? { recordMarkdown } : {}),
    ...(deleted ? { deleted: true } : {})
  })
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

/**
 * Whether this device already tombstoned `foreignId` at or after `clock`: a
 * redelivered record of a merged foreign id owes nothing again.
 */
export function journalTombstonedPast(
  db: DrizzleDb,
  foreignId: string,
  clock: VectorClock
): boolean {
  const tombstone = readTombstoneClock(db, 'journal', foreignId)
  if (!tombstone) return false
  const order = compareClocks(tombstone, clock)
  return order === 'after' || order === 'equal'
}

export interface JournalDayMergeDeps {
  db: DrizzleDb
  deviceId: string
  /** Merges the server's body for `id` into its local doc. False when it is not fully merged. */
  pullBody: (id: string) => Promise<boolean>
  /** The day file's body when `id` is the local row holding `date`, else null. */
  localHolderText: (id: string, date: string) => string | null
  /** Whether `id`'s local doc holds any Yjs state. */
  hasBody: (id: string) => Promise<boolean>
  /**
   * Whether `id` holds anything right now: an editor window has it open, its
   * day file text, when it holds `date`, or its open doc's state. Synchronous,
   * so no typing lands between this check and a forget's row removal (#3008).
   * An open editor counts because main has not applied the edits it sent yet
   * (#3019); they arrive before its close, on the same IPC channel.
   */
  holdsTextNow: (id: string, date: string) => boolean
  /**
   * Makes `j<date>` hold the day: a foreign local row gives it up (its file
   * text is kept in its owed merge first), then `j<date>` is created empty.
   * Never writes over a day file that no row holds.
   */
  ensureDay: (date: string) => Promise<void>
  /** Points the foreign id's task links at the day. */
  relinkTasks: (fromId: string, toId: string) => Promise<void>
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
  purgeDoc: (id: string) => Promise<void>
  /** Removes `id`'s local row, if any, from both databases. */
  removeRow: (id: string) => void
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

/** `j<date>` has no row here and this device recorded its tombstone. */
function dayDeleted(db: DrizzleDb, targetId: string): boolean {
  return !getNoteMetadataById(db, targetId) && readTombstoneClock(db, 'journal', targetId) !== null
}

async function mergeOne(deps: JournalDayMergeDeps, merge: OwedJournalDayMerge): Promise<boolean> {
  const targetId = generateJournalId(merge.date)
  // A deleted id's server body is already in the day, merged by the device
  // that deleted it; only what this device holds is left to fold in.
  const bodyPulled = merge.deleted === true || (await deps.pullBody(merge.foreignId))
  // A blank snapshot keeps nothing: the day file is read again, since the
  // user may have typed into it since (#3008).
  let fallback = merge.fallbackMarkdown?.trim() ? merge.fallbackMarkdown : null
  if (bodyPulled && fallback === null) {
    fallback = deps.localHolderText(merge.foreignId, merge.date)
    // Kept before `ensureDay` writes the day file over.
    if (fallback !== null) oweJournalDayMerge(deps.db, { ...merge, fallbackMarkdown: fallback })
  }
  // A deleted id's record text was merged by the device that deleted it;
  // building it again here would add a second copy. This device's own Yjs
  // state and its holder file text still fold: they may never have been
  // pushed (#2984).
  if (!merge.deleted) fallback ??= merge.recordMarkdown ?? null
  const hasBody = bodyPulled && (Boolean(fallback?.trim()) || (await deps.hasBody(merge.foreignId)))
  const step = planJournalDayMerge({
    deleted: merge.deleted === true,
    bodyPulled,
    hasBody,
    dayDeleted: dayDeleted(deps.db, targetId),
    clocked: Object.keys(merge.clock ?? {}).length > 0
  })
  if (step.action === 'wait') {
    log.info('Foreign journal merge waits for its body', describe(merge))
    return false
  }
  if (step.action === 'merge') {
    await deps.ensureDay(merge.date)
    await deps.relinkTasks(merge.foreignId, targetId)
    if (!(await deps.absorbBody(targetId, merge.foreignId, fallback))) {
      log.warn('Foreign journal had nothing to fold; it stays owed', describe(merge))
      return false
    }
  }

  // A forgotten id goes from this device, as in the core: a row a pre-fix
  // build left would keep the day, and typing would land in a dead id. Before
  // the owed merge drops, so a restart in between forgets it again. Typing
  // into the open blank day during the awaits above would be lost with the
  // purge, so the forget waits; the next drain merges it (#3008).
  if (step.action === 'forget') {
    if (deps.holdsTextNow(merge.foreignId, merge.date)) {
      log.info('Blank foreign journal gained text; the forget waits', describe(merge))
      return false
    }
    deps.removeRow(merge.foreignId)
  }

  // The tombstone and dropping the owed merge commit together, before the
  // purge: a restart in between leaves either both or neither (#2985).
  deps.db.transaction(() => {
    if (step.tombstone && merge.clock) {
      const clock = incrementClock(merge.clock, deps.deviceId)
      const payload = JSON.stringify({ clock })
      recordPendingDelete(deps.db, 'journal', merge.foreignId, payload)
      recordTombstoneClock(deps.db, 'journal', merge.foreignId, clock)
      deps.enqueueDelete(merge.foreignId, payload)
    }
    deps.db
      .delete(syncState)
      .where(eq(syncState.key, KEY_PREFIX + merge.foreignId))
      .run()
  })
  // A dropped `F` stays live: its local doc may hold edits not yet pushed.
  if (step.action !== 'drop') await deps.purgeDoc(merge.foreignId)
  log.info('Settled a foreign journal for its day', {
    ...describe(merge),
    targetId,
    action: step.action
  })
  return true
}

/**
 * The client id a local foreign doc is built under from its file text. Fixed
 * per (foreign id, device), so a rebuild after a crash mints the same Yjs
 * items and the fold adds nothing twice; per device, so two devices that
 * each build their own copy never share item ids for different content.
 */
export function fallbackClientId(foreignId: string, deviceId: string): number {
  return createHash('sha256').update(`${foreignId}\0${deviceId}`).digest().readUInt32BE(0)
}

export function readDayBody(date: string): string | null {
  try {
    const raw = readJournalTextSync(date)
    return raw === null ? null : parseJournalEntry(raw, date).content
  } catch (error) {
    log.warn('Could not read a journal day file', { date, error })
    return null
  }
}

/**
 * Removes a journal row from the index DB, then the data DB. The two are
 * separate databases: a kill in between leaves the data row, which the next
 * drain removes again. An index row with no data row (older builds removed
 * the data row first) still counts as the holder in `ensureJournalDay`.
 */
export function removeJournalRow(db: DrizzleDb, id: string): void {
  const indexDb = getIndexDatabase()
  deleteNoteCache(indexDb, id)
  deleteNoteMetadata(db, id)
  deleteNoteFromCache(indexDb, id)
}

/** `ensureDay` against the real vault and databases. */
export async function ensureJournalDay(db: DrizzleDb, date: string): Promise<void> {
  const targetId = generateJournalId(date)
  const path = getJournalRelativePath(date)
  const row = getNoteMetadataByPath(db, path)
  const holder = row ?? getNoteCacheByPath(getIndexDatabase(), path)
  if (holder?.id === targetId) return
  if (holder) {
    oweJournalDayMerge(db, {
      foreignId: holder.id,
      date,
      clock: row?.clock ?? null,
      fallbackMarkdown: readDayBody(date)
    })
    removeJournalRow(db, holder.id)
  } else if (readDayBody(date)?.trim()) {
    throw new Error('The day file has text but no row; left for the indexer')
  }
  await createJournalEntry({ date, content: '' })
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
    pullBody,
    localHolderText: (id, date) =>
      getNoteMetadataByPath(db, getJournalRelativePath(date))?.id === id ? readDayBody(date) : null,
    hasBody: (id) => provider.hasDocState(id),
    holdsTextNow: (id, date) => {
      if (provider.getOpenNoteIds({ active: true }).includes(id)) return true
      const doc = provider.getDoc(id)
      if (doc && Y.encodeStateAsUpdate(doc).length > EMPTY_DOC_UPDATE_BYTES) return true
      return getNoteMetadataByPath(db, getJournalRelativePath(date))?.id === id
        ? readDayBody(date)?.trim() !== ''
        : false
    },
    ensureDay: (date) => ensureJournalDay(db, date),
    relinkTasks: relinkTasksToMergedNote,
    absorbBody: (targetId, foreignId, fallbackMarkdown) =>
      provider.absorbForeignDoc(
        targetId,
        foreignId,
        fallbackMarkdown,
        fallbackClientId(foreignId, deviceId)
      ),
    purgeDoc: (id) => provider.purge(id),
    removeRow: (id) => removeJournalRow(db, id),
    enqueueDelete: (id, payload) => journalSync.enqueueRecoveredDelete(id, payload)
  })
}
