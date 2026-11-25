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
import { relative, sep } from 'path'
import { and, eq, like, ne } from 'drizzle-orm'
import * as Y from 'yjs'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
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
import {
  deleteNoteMetadata,
  getNoteMetadataById,
  getNoteMetadataByPath,
  updateNoteMetadata
} from '@memry/storage-data'
import { attachmentFiles } from '@memry/db-schema/data-schema'
import type { NoteMetadata } from '@memry/db-schema/schema/note-metadata'
import { foldTag } from '@memry/shared/tag-fold'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database/client'
import { getStatus as getVaultStatus } from '../vault/status'
import { deleteNoteCache, getNoteCacheByPath } from '../database/queries/notes'
import { createJournalEntry } from '../journal/create-entry'
import { addJournalTags } from '../journal/update-entry'
import { mergeTagLists } from '../vault/frontmatter'
import { getJournalRelativePath, parseJournalEntry, readJournalTextSync } from '../vault/journal'
import { deleteNoteFromCache } from '../vault/note-sync'
import { relinkTasksToMergedNote } from '../notes/runtime-effects'
import { EMPTY_DOC_UPDATE_BYTES, getCrdtProvider } from './crdt-provider'
import { countNoteFiles, isRecordedAttachment, ownFolderFiles } from './attachment-files'
import { getJournalSyncService } from './journal-sync'
import { JOURNAL_DAY_MERGE_KEY_PREFIX as KEY_PREFIX } from './journal-day-merge-key'
import { recordPendingDelete } from './pending-deletes'

const log = createLogger('JournalDayMerge')

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
  /**
   * The day file tags of the local row that gave the day up: this device's,
   * added like `fallbackMarkdown`, even when the id was deleted elsewhere. The
   * fold carries the doc's `tags` array, but the day file owns its tags
   * (#5476), so the merge adds these to the file. Owed merges written before
   * `recordTags` kept the record's tags here too; they are added as this
   * device's, since dropping them could drop a tag only this device held.
   */
  tags?: string[]
  /**
   * The clock of the local row `tags` were read from, merged across
   * sightings. Absent in an owed merge an older build wrote, and when the row
   * was edited since its sync: its tags all count as unpushed.
   */
  holderClock?: VectorClock | null
  /**
   * The holder tags the device that deleted the foreign id may never have
   * seen, weighed against its tombstone's clock (`unpushedHolderTags`). Added
   * when the id was deleted elsewhere. Absent until a tombstone is weighed:
   * every holder tag counts. Later weighings add to it.
   */
  unpushedTags?: string[]
  /**
   * The foreign record's `tags`. Skipped like `recordMarkdown` when the id was
   * deleted elsewhere: the deleting device merged them, and a tag removed
   * since must not come back. The newest record's replace the ones kept, for
   * the same reason (core: `journal_day_merge/owed.rs`).
   */
  recordTags?: string[]
  /**
   * The attachment references of the local row that gave the day up. The row
   * goes before the merge runs, so they are kept here for the day (OL-M47).
   */
  attachmentReferences?: string[]
}

/**
 * Record that `foreignId`'s body belongs to `date`'s entry. Idempotent: a
 * second sighting widens the clock, so the tombstone dominates every version
 * seen, and keeps the fallback text and the deleted mark. Declining the ref
 * keeps the manifest from counting the unprojected id as server-only, which
 * would pull it again on every check.
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
  const tags = mergeTagLists(kept?.tags ?? [], merge.tags ?? [])
  const recordTags = merge.recordTags ?? kept?.recordTags ?? []
  const attachmentReferences = unionOf(kept?.attachmentReferences, merge.attachmentReferences)
  const holderClock =
    kept?.holderClock && merge.holderClock
      ? mergeClocks(kept.holderClock, merge.holderClock)
      : (merge.holderClock ?? kept?.holderClock ?? undefined)
  // A sighting reads the holder's tags as its day file holds them now: an
  // unpushed tag the user removed since stays removed (#5694).
  const weighed = addWeighing(kept?.unpushedTags, merge.unpushedTags)
  const held = new Set((merge.tags ?? []).map(foldTag))
  const unpushedTags = merge.tags ? weighed?.filter((tag) => held.has(foldTag(tag))) : weighed
  const value = JSON.stringify({
    ...merge,
    clock,
    ...(fallbackMarkdown ? { fallbackMarkdown } : {}),
    ...(recordMarkdown ? { recordMarkdown } : {}),
    ...(deleted ? { deleted: true } : {}),
    tags: tags.length > 0 ? tags : undefined,
    recordTags: recordTags.length > 0 ? recordTags : undefined,
    attachmentReferences: attachmentReferences.length > 0 ? attachmentReferences : undefined,
    holderClock,
    unpushedTags
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
 * empty body no longer keeps it owed. The tags of a holder the day already
 * displaced are weighed against `tombstone` (#5659), on every delivery.
 */
export function markOwedJournalDayMergeDeleted(
  db: DrizzleDb,
  foreignId: string,
  tombstone: VectorClock | undefined
): void {
  const owed = listOwedJournalDayMerges(db).find((merge) => merge.foreignId === foreignId)
  if (!owed) return
  const unpushedTags = addWeighing(
    owed.unpushedTags,
    owed.tags && owed.holderClock
      ? unpushedHolderTags(db, foreignId, owed.tags, owed.holderClock, tombstone ?? {})
      : undefined
  )
  db.update(syncState)
    .set({
      value: JSON.stringify({ ...owed, deleted: true, unpushedTags }),
      updatedAt: new Date()
    })
    .where(eq(syncState.key, KEY_PREFIX + foreignId))
    .run()
}

/**
 * The first weighing sets the unpushed list and later ones add to it. What a
 * weighing reads is gone after the first: the tombstone drops the holder's
 * queued edit, and `j<D>` removes its row (REVIEW-5691). No list is kept
 * before a weighing, so the union never keeps a tag from before the first.
 */
function addWeighing(
  kept: string[] | undefined,
  weighed: string[] | undefined
): string[] | undefined {
  return kept && weighed ? mergeTagLists(kept, weighed) : (weighed ?? kept)
}

/**
 * The holder tags the device that deleted `foreignId` may never have seen
 * (§1.9.1 step 6; core `HolderTags::read`). None when no edit of the holder is
 * queued and the tombstone's clock covers the holder row's: the deleting
 * device merged the row as it is. Otherwise every one, as with no clock on
 * either side: desktop keeps no snapshot of the last synced tags, so it adds a
 * tag back rather than drop one.
 */
function unpushedHolderTags(
  db: DrizzleDb,
  foreignId: string,
  tags: string[],
  holderClock: VectorClock | null,
  tombstone: VectorClock
): string[] {
  if (!holderClock || Object.keys(holderClock).length === 0) return tags
  if (Object.keys(tombstone).length === 0) return tags
  const order = compareClocks(holderClock, tombstone)
  if (order !== 'before' && order !== 'equal') return tags
  const queued = db
    .select({ id: syncQueue.id })
    .from(syncQueue)
    .where(
      and(
        eq(syncQueue.type, 'journal'),
        eq(syncQueue.itemId, foreignId),
        ne(syncQueue.operation, 'delete')
      )
    )
    .get()
  return queued ? tags : []
}

/**
 * A local holder's tags as its owed merge keeps them: weighed against
 * `tombstone`, by default the one recorded for it, when there is one. A row
 * edited since its sync holds an edit that neither its clock nor the queue
 * may show: one made outside the app is never ticked, and is queued only by
 * the next start's dirty sweep (REVIEW-5691). It has no clock to weigh, so
 * every tag counts. Unknown `tags` (no readable day file) weigh nothing and
 * leave the kept ones as they are: read as none, they would drop every
 * unpushed tag the owed merge holds.
 */
export function holderTags(
  db: DrizzleDb,
  holderId: string,
  tags: string[] | undefined,
  row: Pick<NoteMetadata, 'clock' | 'syncedAt' | 'modifiedAt'> | undefined,
  tombstone: VectorClock | null = readTombstoneClock(db, 'journal', holderId)
): Pick<OwedJournalDayMerge, 'tags' | 'holderClock' | 'unpushedTags'> {
  // The dirty sweep's test (`recoverDirtyJournals`).
  const edited = !row?.syncedAt || row.modifiedAt > row.syncedAt
  const holderClock = edited ? null : (row.clock ?? null)
  if (!tags) return { holderClock }
  return {
    tags,
    holderClock,
    ...(tombstone
      ? { unpushedTags: unpushedHolderTags(db, holderId, tags, holderClock, tombstone) }
      : {})
  }
}

export function listOwedJournalDayMerges(db: DrizzleDb): OwedJournalDayMerge[] {
  return db
    .select({ value: syncState.value })
    .from(syncState)
    .where(like(syncState.key, `${KEY_PREFIX}%`))
    .all()
    .flatMap((row) => {
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse / response.json / require returns any; the asserted type is the wire or persisted contract and a runtime guard here would change behavior
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
  /** The open vault, where a foreign row's attachment files are. */
  vaultPath: string
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
  /** Adds `tags` to `date`'s day file, keeping the ones it has. */
  addDayTags: (date: string, tags: string[]) => Promise<void>
  purgeDoc: (id: string) => Promise<void>
  /** Removes `id`'s local row, if any, from both databases. */
  removeRow: (id: string) => void
  enqueueDelete: (id: string, payload: string) => void
}

function unionOf(a: string[] | null | undefined, b: string[] | null | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])]
}

/**
 * The day takes over the foreign id's attachments: its references, and its
 * file records, so `attachments/<foreignId>/…` that the folded body embeds
 * still resolves and is neither downloaded again nor uploaded as a second
 * copy. The files stay where they are. Nothing is pushed: the folded body
 * already reaches peers, and a `note` record under the day's id is what
 * #5730 keeps from being pushed. Idempotent, so a crash before the tombstone
 * carries the same set again. False when the day has no row to carry to.
 */
function carryAttachments(
  db: DrizzleDb,
  vaultPath: string,
  foreignId: string,
  targetId: string,
  references: string[]
): boolean {
  const day = getNoteMetadataById(db, targetId)
  if (!day) return false
  const merged = unionOf(day.attachmentReferences, references)
  if (merged.length > (day.attachmentReferences ?? []).length) {
    updateNoteMetadata(db, targetId, { attachmentReferences: merged })
  }
  for (const record of db
    .select()
    .from(attachmentFiles)
    .where(eq(attachmentFiles.noteId, foreignId))
    .all()) {
    db.insert(attachmentFiles)
      .values({ ...record, noteId: targetId })
      .onConflictDoNothing()
      .run()
  }
  recordUnnamedFiles(db, vaultPath, foreignId, targetId, references)
  return true
}

/**
 * A foreign row from before the file record (#2651) names its references in
 * no record, so the day would owe each one a download into its own folder: a
 * second copy of a file already in `attachments/<foreignId>/` (REVIEW-5743).
 * The files there that no record pairs with an id hold those references.
 * Ids are random per upload, stored names carry no id, and this device keeps
 * no hash or size per id, so a file pairs with an id only when one reference
 * and one file are unrecorded. Otherwise the files are counted as known, as
 * `recordAttachmentFile` counts an older note's, so none is uploaded again,
 * and the references stay owed: the downloader moves a file that is really
 * missing to where the body links it, and one already here may land a second
 * copy (VERIFY-5743R2).
 */
function recordUnnamedFiles(
  db: DrizzleDb,
  vaultPath: string,
  foreignId: string,
  targetId: string,
  references: string[]
): void {
  const unnamed = references.filter((id) => !isRecordedAttachment(db, targetId, id))
  if (unnamed.length === 0) return
  const paired = new Set(
    db
      .select({ path: attachmentFiles.path, attachmentId: attachmentFiles.attachmentId })
      .from(attachmentFiles)
      .where(eq(attachmentFiles.noteId, targetId))
      .all()
      .flatMap((row) => (row.attachmentId === null ? [] : [row.path]))
  )
  const files = ownFolderFiles(vaultPath, foreignId).filter(
    (file) => !paired.has(relative(vaultPath, file).split(sep).join('/'))
  )
  if (files.length === 0) return
  // A file is recorded under an attachment id only when nothing else could be
  // that attachment. Directory order is not upload order, so two or more never
  // pair by position: a wrong pair revives the wrong bytes under an id.
  if (files.length !== 1 || unnamed.length !== 1) {
    countNoteFiles(db, vaultPath, targetId, files)
    log.warn('A foreign journal names attachments no file can be paired with', {
      foreignId,
      targetId,
      unnamed: unnamed.length,
      files: files.length
    })
    return
  }
  const [attachmentId] = unnamed
  db.insert(attachmentFiles)
    .values({
      noteId: targetId,
      path: relative(vaultPath, files[0]).split(sep).join('/'),
      attachmentId,
      recordedAt: Date.now()
    })
    .onConflictDoUpdate({
      target: [attachmentFiles.noteId, attachmentFiles.path],
      set: { attachmentId, recordedAt: Date.now() }
    })
    .run()
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

/** Whether `j<date>`'s day file lacks one of `tags`, by the tag fold. */
function dayLacksTag(db: DrizzleDb, date: string, tags: string[]): boolean {
  if (tags.length === 0) return false
  const held =
    getNoteMetadataByPath(db, getJournalRelativePath(date))?.id === generateJournalId(date)
      ? (readDayTags(date) ?? [])
      : []
  const keys = new Set(held.map(foldTag))
  return tags.some((tag) => !keys.has(foldTag(tag)))
}

/** A deleted id's tags the deleting device saw were added by it. */
function addedTags(merge: OwedJournalDayMerge): string[] {
  return merge.deleted
    ? (merge.unpushedTags ?? merge.tags ?? [])
    : mergeTagLists(merge.tags ?? [], merge.recordTags ?? [])
}

/** `j<date>` has no row here and this device recorded its tombstone. */
function dayDeleted(db: DrizzleDb, targetId: string): boolean {
  return !getNoteMetadataById(db, targetId) && readTombstoneClock(db, 'journal', targetId) !== null
}

async function mergeOne(deps: JournalDayMergeDeps, merge: OwedJournalDayMerge): Promise<boolean> {
  const targetId = generateJournalId(merge.date)
  // Read before `ensureDay` removes a foreign row that holds the day.
  const references = unionOf(
    merge.attachmentReferences,
    getNoteMetadataById(deps.db, merge.foreignId)?.attachmentReferences
  )
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
  const tags = addedTags(merge)
  // A tag the day lacks may exist nowhere else, as one added offline to a
  // blank holder: it merges with no body (#5659, #5699).
  const carriesTags = dayLacksTag(deps.db, merge.date, tags)
  const hasBody =
    bodyPulled &&
    (Boolean(fallback?.trim()) || (await deps.hasBody(merge.foreignId)) || carriesTags)
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
    if (!(await deps.absorbBody(targetId, merge.foreignId, fallback)) && !carriesTags) {
      log.warn('Foreign journal had nothing to fold; it stays owed', describe(merge))
      return false
    }
    // Invariant (#5694): the tags added are the holder's as it holds them
    // when the day takes it over, never as they were when the merge was owed.
    // `ensureDay` owes a holder `F` again from its day file as it removes it,
    // so the owed merge is read back after it.
    const owed = listOwedJournalDayMerges(deps.db).find((o) => o.foreignId === merge.foreignId)
    const added = owed ? addedTags(owed) : tags
    if (added.length > 0) await deps.addDayTags(merge.date, added)
    carryAttachments(deps.db, deps.vaultPath, merge.foreignId, targetId, references)
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
    if (
      !carryAttachments(deps.db, deps.vaultPath, merge.foreignId, targetId, references) &&
      references.length
    ) {
      log.warn('A forgotten foreign journal leaves its attachments with no day', describe(merge))
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
  return readDay(date)?.content ?? null
}

/** Undefined when the day file is missing or will not read: its tags are unknown, not none. */
export function readDayTags(date: string): string[] | undefined {
  const day = readDay(date)
  if (!day) return undefined
  const tags: unknown = day.frontmatter.tags
  return Array.isArray(tags) ? tags.map(String) : []
}

function readDay(date: string): ReturnType<typeof parseJournalEntry> | null {
  try {
    const raw = readJournalTextSync(date)
    return raw === null ? null : parseJournalEntry(raw, date)
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
      fallbackMarkdown: readDayBody(date),
      ...holderTags(db, holder.id, readDayTags(date), row),
      attachmentReferences: row?.attachmentReferences ?? undefined
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
  const vaultPath = getVaultStatus().path
  if (!deviceId || !journalSync || !vaultPath) return
  const provider = getCrdtProvider()
  await drainJournalDayMerges({
    db,
    vaultPath,
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
    addDayTags: addJournalTags,
    purgeDoc: (id) => provider.purge(id),
    removeRow: (id) => removeJournalRow(db, id),
    enqueueDelete: (id, payload) => journalSync.enqueueRecoveredDelete(id, payload)
  })
}
