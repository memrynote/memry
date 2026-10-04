import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { getCrdtProvider } from './crdt-provider'
import { feedExternalEditToCrdt } from './crdt-external-feed'
import { owesFileBody } from './crdt-owed-file-body'
import type { SourceRestoreOutcome } from './blocknote-converter'
import { serializeNoteBody, type NoteBody } from './writing-markdown'
import { loadBlockNoteConverter } from './blocknote-converter-loader'
import { emitNoteUpdated } from '@memry/sync-client/note-events'
import {
  isWritingFrontmatterValue,
  writingFrontmatterOf,
  toWritingFrontmatterValue,
  WRITING_FRONTMATTER_KEY,
  type WritingFrontmatter
} from '@memry/shared'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { utcNow } from '@memry/shared/utc'
import { atomicWrite, safeRead, ensureDirectory } from '../vault/file-ops'
import {
  generateContentHash,
  parseNote,
  serializeNote,
  serializeParsedNote,
  type NoteFrontmatter
} from '../vault/frontmatter'
import { splitFrontmatterBlock } from '@memry/shared/frontmatter-split'
import {
  getVaultRoot,
  toAbsolutePath,
  createSnapshot,
  maybeCreateSignificantSnapshot
} from '../vault/notes'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getJournalPath } from '../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../vault/note-sync'
import { reconcileRenamedAttachments } from '../vault/attachment-rename-reconcile'
import { flushProjectionEvents } from '../projections'
import { getIndexDatabase, getDatabase } from '../database/client'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { createRemindersService, type RemindersServiceHooks } from '@memry/app-core/reminders'
import { syncNoteDateReminders, clearNoteDateReminders } from '../notes/note-date-reminders'
import { deleteFile } from '../vault/file-ops'
import { NotesChannels, JournalChannels } from '@memry/contracts/ipc-channels'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import path from 'path'
import { isDeepStrictEqual } from 'node:util'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from './local-mutations'

// Forwards app-core reminder writes to the sync queue. app-core cannot import
// desktop sync code directly (architecture boundary), so this is injected.
const reminderSyncHooks: RemindersServiceHooks = {
  onMutate: (op, id, snapshot) => {
    if (op === 'create') enqueueLocalSyncCreate('reminder', id)
    else if (op === 'update') enqueueLocalSyncUpdate('reminder', id)
    else enqueueLocalSyncDelete('reminder', id, snapshot)
  }
}

const log = createLogger('CrdtWriteback')

const WRITEBACK_DEBOUNCE_MS = 500

/**
 * How many times the last pass's own cost a note must stay idle before the next
 * write-back may start.
 *
 * A pass re-serializes the WHOLE document (`yDocToMarkdown`), so it costs what
 * the note is big rather than what the edit was: ~36ms for a 2KB note, ~134ms at
 * 12KB, ~430ms at 49KB. The debounce re-arms per update, so it never fires while
 * keys land faster than every 500ms — but a typing rhythm whose gaps sit around
 * half a second (word and sentence pauses) fires the whole pipeline on each one,
 * up to twice a second. Spacing passes by a multiple of their own cost caps
 * write-back at roughly 1/(1 + FACTOR) of wall clock per note. Cheap notes never
 * reach the 500ms floor, so their timing is unchanged.
 */
const WRITEBACK_COOLDOWN_FACTOR = 9

/**
 * Ceiling on that cooldown. The markdown file is the user's data, so however
 * expensive a note gets, it may never lag the live doc by more than this.
 */
const WRITEBACK_MAX_COOLDOWN_MS = 5000

const IGNORED_WRITE_TTL_MS = 5000

/**
 * Whose edit a pass writes: `local` for this device's editor, `remote` for
 * state merged from the server. Only a local edit may put the reminders it
 * derives on the sync queue; see `performWriteback`.
 */
export type WritebackSource = 'local' | 'remote'

interface PendingWriteback {
  timer: ReturnType<typeof setTimeout>
  doc: Y.Doc
  /** Any update since the last pass was a local edit. */
  local: boolean
  /** Latest server time (ms) of a remote edit merged since the last pass. */
  remoteEditedAtMs: number | undefined
}

interface WritebackCost {
  finishedAt: number
  durationMs: number
}

const lastWritebackCost = new Map<string, WritebackCost>()
const pendingTimers = new Map<string, PendingWriteback>()
const inFlightWritebacks = new Set<string>()
const ignoredWrites = new Map<string, number>()
const lastNetworkUpdateMs = new Map<string, number>()
/** Note id to the content hash of the file bytes this module last wrote for it. */
const lastWrittenHash = new Map<string, string>()

/**
 * True while this note's on-disk markdown is known to be behind the live doc —
 * a writeback is debounced or mid-write. Readers that treat the file as the
 * source of truth (see tasks/reconcile-markdown-tasks) must stand down in this
 * window, or they would "restore" state the user just changed in the app.
 */
export function hasPendingWriteback(noteId: string): boolean {
  return pendingTimers.has(noteId) || inFlightWritebacks.has(noteId)
}

interface WritebackDebugState {
  pending: boolean
  scheduledCount: number
  performedCount: number
  lastMarkdown: string | null
  lastError: string | null
  /** What the last pass did with the author's bytes (#1915), null before any pass. */
  sourceRestore: SourceRestoreOutcome | null
}

/**
 * E2E-only bookkeeping. `lastMarkdown` is the entire serialized note body, and
 * nothing evicts entries, so populating this in a real session would pin one
 * full copy of every edited note in the main process for the app's lifetime.
 * The only reader is the `getWritebackDebugState` test hook, which is itself
 * registered behind the same gate (see `registerTestHooks`).
 */
const debugState = new Map<string, WritebackDebugState>()

function updateDebugState(noteId: string, patch: Partial<WritebackDebugState>): void {
  if (process.env.NODE_ENV !== 'test') return
  const current = debugState.get(noteId) ?? {
    pending: false,
    scheduledCount: 0,
    performedCount: 0,
    lastMarkdown: null,
    lastError: null,
    sourceRestore: null
  }
  debugState.set(noteId, { ...current, ...patch })
}

export function getWritebackDebugState(noteId: string): WritebackDebugState | null {
  return debugState.get(noteId) ?? null
}

function isJournalId(noteId: string): boolean {
  return noteId.startsWith('j') && /^j\d{4}-\d{2}-\d{2}$/.test(noteId)
}

function journalIdToDate(journalId: string): string {
  return journalId.slice(1)
}

/**
 * Amortized TTL eviction, at most one full pass per TTL window.
 *
 * Both maps below are keyed per file/per note and are only ever written, so
 * they need a sweep to stay bounded — but the sweep must not run per call:
 * `isWritebackIgnored` fires on every watcher file event, where an inline pass
 * cost O(map) each time. Gating the pass on its own TTL keeps both maps to the
 * entries written in the last two windows at amortized O(1) per call.
 */
function sweepExpired(entries: Map<string, number>, ttlMs: number, now: number): void {
  for (const [key, ts] of entries) {
    if (now - ts >= ttlMs) entries.delete(key)
  }
}

let ignoredWritesSweptAt = 0
let networkUpdatesSweptAt = 0

export function isWritebackIgnored(absolutePath: string): boolean {
  const now = Date.now()
  if (now - ignoredWritesSweptAt >= IGNORED_WRITE_TTL_MS) {
    ignoredWritesSweptAt = now
    sweepExpired(ignoredWrites, IGNORED_WRITE_TTL_MS, now)
  }
  const ts = ignoredWrites.get(absolutePath)
  if (!ts) return false
  return now - ts < IGNORED_WRITE_TTL_MS
}

export function clearWritebackIgnore(_absolutePath: string): void {
  // no-op: auto-evicted by TTL in isWritebackIgnored
}

/**
 * Sweeping on the write path too, so a stopped watcher (which is what stops
 * `isWritebackIgnored` from being called at all) cannot leave the map growing
 * one entry per written file for the rest of the session.
 */
function rememberIgnoredWrite(absolutePath: string): void {
  const now = Date.now()
  if (now - ignoredWritesSweptAt >= IGNORED_WRITE_TTL_MS) {
    ignoredWritesSweptAt = now
    sweepExpired(ignoredWrites, IGNORED_WRITE_TTL_MS, now)
  }
  ignoredWrites.set(absolutePath, now)
}

export function markWritebackIgnored(absolutePath: string): void {
  rememberIgnoredWrite(absolutePath)
}

const CONCURRENT_EDIT_WINDOW_MS = 2000

export function recordNetworkUpdate(noteId: string): void {
  const now = Date.now()
  // Only `wasRecentNetworkUpdate` used to delete, and it is reached only when
  // that note is edited externally on disk — so without this the map grew one
  // entry per note ever received from the network, for the whole session.
  if (now - networkUpdatesSweptAt >= CONCURRENT_EDIT_WINDOW_MS) {
    networkUpdatesSweptAt = now
    sweepExpired(lastNetworkUpdateMs, CONCURRENT_EDIT_WINDOW_MS, now)
  }
  lastNetworkUpdateMs.set(noteId, now)
}

export function wasRecentNetworkUpdate(noteId: string): boolean {
  const ts = lastNetworkUpdateMs.get(noteId)
  if (!ts) return false
  if (Date.now() - ts >= CONCURRENT_EDIT_WINDOW_MS) {
    lastNetworkUpdateMs.delete(noteId)
    return false
  }
  return true
}

function emitToRenderer(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

/**
 * Delay before the next pass for this note: the debounce, extended while the
 * previous pass's cooldown is still running. Never shortens the debounce.
 */
function writebackDelayMs(noteId: string): number {
  const last = lastWritebackCost.get(noteId)
  if (!last) return WRITEBACK_DEBOUNCE_MS
  const cooldownMs = Math.min(
    last.durationMs * WRITEBACK_COOLDOWN_FACTOR,
    WRITEBACK_MAX_COOLDOWN_MS
  )
  return Math.max(WRITEBACK_DEBOUNCE_MS, last.finishedAt + cooldownMs - Date.now())
}

/**
 * The doc to serialize for this note at the moment the pass actually runs.
 *
 * A scheduled write-back captures the Y.Doc that was live when it was armed,
 * but a note can be closed and reopened inside the debounce window: `doOpen`
 * puts a *different* Y.Doc in the provider's map for the same note id, and the
 * still-armed timer would otherwise serialize the superseded doc straight onto
 * the markdown file — clobbering whatever landed there in the meantime (a sync
 * pull writing the file, an external editor, or the replacement doc's own
 * state). Destroying the superseded doc on the close path does not prevent
 * this: `Y.Doc.destroy()` leaves the doc's store readable, so the stale
 * serialize still succeeds.
 *
 * The provider's map is the authority for "which doc is this note", so resolve
 * by note id here rather than trusting the captured reference. When the note is
 * genuinely absent from the map — closed and not reopened, or evicted by the
 * inactive-doc LRU — the captured doc is still the last known state and its
 * write-back must still land, so it stays the fallback.
 */
function resolveWritebackDoc(noteId: string, captured: Y.Doc): Y.Doc {
  const live = getCrdtProvider().getDoc(noteId)
  if (!live || live === captured) return captured
  log.debug('Write-back doc was superseded; serializing the live doc', { noteId })
  return live
}

/**
 * The edit time a pass stamps on the note (#2515). A local edit happened now.
 * A remote pass is no edit made here: it keeps the row's time, moved forward
 * only to the server time of the remote edit it merged, never backwards. A
 * snapshot, a pack or an older peer's update carries no such time, so a
 * re-pull or a re-serialized body leaves the note where it was.
 */
function writebackModifiedAt(
  current: string | null | undefined,
  local: boolean,
  remoteEditedAtMs: number | undefined
): string {
  if (local) return utcNow()
  const remoteMs =
    remoteEditedAtMs !== undefined && Number.isFinite(remoteEditedAtMs) && remoteEditedAtMs > 0
      ? remoteEditedAtMs
      : undefined
  const currentMs = current ? Date.parse(current) : NaN
  if (!current || !Number.isFinite(currentMs)) {
    return remoteMs !== undefined ? new Date(remoteMs).toISOString() : utcNow()
  }
  return remoteMs !== undefined && remoteMs > currentMs ? new Date(remoteMs).toISOString() : current
}

function laterEditTime(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/** Runs a pass and records what it cost, which is what paces the next one. */
async function runWriteback(
  noteId: string,
  doc: Y.Doc,
  local: boolean,
  remoteEditedAtMs: number | undefined
): Promise<void> {
  const startedAt = Date.now()
  try {
    await performWriteback(noteId, resolveWritebackDoc(noteId, doc), local, remoteEditedAtMs)
  } finally {
    const finishedAt = Date.now()
    lastWritebackCost.set(noteId, { finishedAt, durationMs: finishedAt - startedAt })
  }
}

/**
 * @param remoteEditedAtMs - For a `remote` pass, the server time of the edit
 * that armed it, when the update carried one.
 */
export function scheduleWriteback(
  noteId: string,
  doc: Y.Doc,
  source: WritebackSource,
  remoteEditedAtMs?: number
): void {
  const existing = pendingTimers.get(noteId)
  if (existing) clearTimeout(existing.timer)
  const local = source === 'local' || existing?.local === true
  const pendingRemoteEditedAtMs = laterEditTime(
    existing?.remoteEditedAtMs,
    source === 'remote' ? remoteEditedAtMs : undefined
  )
  updateDebugState(noteId, {
    pending: true,
    scheduledCount: (debugState.get(noteId)?.scheduledCount ?? 0) + 1,
    lastError: null
  })

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId)
    inFlightWritebacks.add(noteId)
    runWriteback(noteId, doc, local, pendingRemoteEditedAtMs)
      .catch((err) => {
        updateDebugState(noteId, {
          pending: false,
          lastError: err instanceof Error ? err.message : String(err)
        })
        log.error('Write-back failed', { noteId, error: err })
        // A failed write-back means typed content was NOT persisted to disk.
        // Throttled: a persistent disk fault would otherwise fire per debounce.
        if (shouldEmitThrottled(`note_writeback_error:${noteId}`)) {
          trackMainError('notes', 'note_writeback', err)
        }
        emitToRenderer('sync:write-back-failed', { noteId })
      })
      .finally(() => {
        inFlightWritebacks.delete(noteId)
      })
  }, writebackDelayMs(noteId))

  pendingTimers.set(noteId, { timer, doc, local, remoteEditedAtMs: pendingRemoteEditedAtMs })
}

/**
 * Disarm one note's pending pass, for a note that is ceasing to exist.
 *
 * The armed timer holds its own reference to the Y.Doc, so closing or purging
 * the doc does not reach it. A pass that fires while the delete is under way
 * can still find the row, and write the file back after the delete unlinks it.
 */
export function cancelWriteback(noteId: string): void {
  const pending = pendingTimers.get(noteId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingTimers.delete(noteId)
  }
  lastWritebackCost.delete(noteId)
  lastWrittenHash.delete(noteId)
  debugState.delete(noteId)
}

/**
 * Run this note's pass now, in place of any armed one, and resolve once the
 * file is written. For a caller that must know the file matches the doc
 * before it moves on, such as the post-pull materialize of packed bodies.
 */
export async function writebackNow(noteId: string, doc: Y.Doc): Promise<void> {
  const pending = pendingTimers.get(noteId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingTimers.delete(noteId)
  }
  inFlightWritebacks.add(noteId)
  try {
    await runWriteback(noteId, doc, pending?.local === true, pending?.remoteEditedAtMs)
  } finally {
    inFlightWritebacks.delete(noteId)
  }
}

/**
 * Run this note's armed pass now, if one is armed, so a caller that reads the
 * file back right after a write reports what the file keeps (#2615). A failed
 * pass is logged, not thrown: the file then holds what the write left.
 */
export async function settleWriteback(noteId: string): Promise<void> {
  const pending = pendingTimers.get(noteId)
  if (!pending) return
  try {
    await writebackNow(noteId, pending.doc)
  } catch (err) {
    log.warn('Write-back failed while settling', { noteId, error: err })
  }
}

export function cancelPendingWritebacks(): void {
  for (const { timer } of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
  lastWritebackCost.clear()
}

/**
 * Sizes of the module-level maps. Diagnostics only — the growth of these maps
 * is the bug this bookkeeping exists to keep regression-testable, and neither
 * `isWritebackIgnored` nor `wasRecentNetworkUpdate` can distinguish "entry
 * expired" from "entry evicted", so a leak is otherwise unobservable.
 */
export function getWritebackStateSizes(): {
  ignoredWrites: number
  networkUpdates: number
  lastWrittenHashes: number
  debugState: number
} {
  return {
    ignoredWrites: ignoredWrites.size,
    networkUpdates: lastNetworkUpdateMs.size,
    lastWrittenHashes: lastWrittenHash.size,
    debugState: debugState.size
  }
}

/**
 * Drop every per-note/per-file map. These are module-level, so without this a
 * vault switch would carry the previous vault's bookkeeping — paths and note
 * ids that no longer exist here — into the next session, and each successive
 * vault would add to it. Called from `CrdtProvider.destroy()`, which is the
 * one point every vault close, vault switch and sync-runtime stop goes through.
 */
export function resetWritebackState(): void {
  lastWritebackCost.clear()
  ignoredWrites.clear()
  lastNetworkUpdateMs.clear()
  lastWrittenHash.clear()
  debugState.clear()
  ignoredWritesSweptAt = 0
  networkUpdatesSweptAt = 0
}

export async function flushPendingWritebacks(): Promise<void> {
  const pending = Array.from(pendingTimers.entries())
  pendingTimers.clear()
  for (const [, { timer }] of pending) clearTimeout(timer)
  await Promise.all(
    pending.map(([noteId, { doc, local, remoteEditedAtMs }]) =>
      runWriteback(noteId, doc, local, remoteEditedAtMs).catch((err) => {
        log.error('Write-back failed during shutdown flush', { noteId, error: err })
      })
    )
  )
}

/**
 * Second opinion on "does this note already exist here?".
 *
 * `note_metadata` (data DB) is written synchronously by the sync item handler,
 * while its `note_cache` row (index DB) only lands once the projection lane
 * drains — which `applyUpsert` does not await. A write-back firing inside that
 * gap would see no cache row and skip the pass, leaving the just-applied
 * note's file without the body its doc holds.
 */
function resolveFromCanonicalMetadata(
  noteId: string
): ReturnType<typeof getNoteCacheById> | undefined {
  try {
    const canonical = getNoteMetadataById(getDatabase(), noteId)
    if (!canonical) return undefined

    log.debug('Write-back: index row not projected yet, using canonical metadata', { noteId })
    return {
      ...canonical,
      date: canonical.journalDate ?? null
    } as unknown as ReturnType<typeof getNoteCacheById>
  } catch (err) {
    log.warn('Write-back: canonical metadata lookup failed', { noteId, error: err })
    return undefined
  }
}

async function performWriteback(
  noteId: string,
  doc: Y.Doc,
  local: boolean,
  remoteEditedAtMs: number | undefined
): Promise<void> {
  // Loaded before the note row is read, so the row below is as fresh as it
  // was before the converter became lazy: past this line nothing awaits until
  // the serialization itself.
  const converter = await loadBlockNoteConverter()
  // A doc with no note row is never turned into a note. Its record may not
  // have arrived yet, or it may be a tombstone this device has not pulled (a
  // packed body applied before the first record pull), and both look the
  // same from here. The record is what creates the file; its arrival then
  // writes this body over it (`CrdtProvider.materialize`, or the walk the
  // record's body debt runs).
  const indexDb = getIndexDatabase()
  const indexed = getNoteCacheById(indexDb, noteId)
  const cached = indexed ?? resolveFromCanonicalMetadata(noteId)
  if (!cached) {
    updateDebugState(noteId, { pending: false })
    log.debug('Write-back skipped: no note row', { noteId })
    return
  }

  // Fail closed. If the doc holds a node type this build has no schema spec
  // for, every serialization of it is missing that node — writing the result
  // would make the loss the file's permanent content, and the next index pass
  // would push it to every other device. Keeping the file costs the user a
  // stale body until a build that knows the type runs; writing costs them the
  // content. Checked before serializing, since the answer decides nothing else.
  const unrepresentable = converter.findUnrepresentableNodes(doc)
  if (unrepresentable.length > 0) {
    updateDebugState(noteId, {
      pending: false,
      lastError: `unrepresentable: ${unrepresentable.join(',')}`
    })
    log.error('Doc holds node types this build cannot serialize, keeping the file', {
      noteId,
      nodes: unrepresentable
    })
    if (shouldEmitThrottled(`writeback_unrepresentable:${noteId}`)) {
      trackMainLog('error', {
        scope: 'CrdtWriteback',
        action: 'writeback_unrepresentable_node',
        errorCode: unrepresentable.join(',')
      })
    }
    return
  }

  const body = await serializeNoteBody(
    doc,
    {
      notePath: cached.path,
      readFileBody: async () => {
        const raw = await safeRead(toAbsolutePath(cached.path))
        return raw === null ? null : splitFrontmatterBlock(raw).body
      },
      onSourceRestore: (sourceRestore) => updateDebugState(noteId, { sourceRestore })
    },
    converter
  )
  const markdown = body?.markdown ?? null
  updateDebugState(noteId, {
    pending: false,
    performedCount: (debugState.get(noteId)?.performedCount ?? 0) + 1,
    lastMarkdown: markdown,
    lastError: null
  })
  if (body === null || markdown === null) {
    log.warn('Conversion returned null, keeping stale file', { noteId })
    // Silent editor/file divergence — a serializer regression must show on
    // dashboards. Throttled: fires per debounce while the user keeps typing.
    if (shouldEmitThrottled(`writeback_conversion_null:${noteId}`)) {
      trackMainLog('error', { scope: 'CrdtWriteback', action: 'conversion_null' })
    }
    return
  }

  // A note that owes its file body (#2646) holds bytes the app wrote and the
  // doc has not taken; the index hash moved with them, so only the marker
  // tells. The file is taken only after a complete server merge into the live
  // doc (`CrdtProvider.takeFileAfterMerge`), never by a pass that may run in
  // the middle of one. The full-state row is owed again so the marker has a
  // flush to resolve it. Not for a doc the take refuses (the two fail-closed
  // returns above) or a note with no index row the take can read: each flush
  // would queue the next one.
  if (owesFileBody(noteId)) {
    if (indexed) getCrdtProvider().recordOwedFullState(noteId)
    log.debug('Write-back skipped: the note owes its file body', { noteId })
    return
  }

  // The receiving half of the large-file class. A peer running an older build,
  // or one whose oversized snapshot push was refused at the encrypt cap, still
  // sends the body as incremental CRDT updates — those are individually under
  // the merge cap and pass freely, so the ingest-side guard never sees them.
  // The body lands on disk either way; what degrades is how it is handed on.
  const bodyClass = classifyMarkdownContent(markdown)
  const isLargeFileBody = bodyClass.sizeClass === 'large-file'
  if (isLargeFileBody) {
    log.warn('Inbound body is large-file class; degrading the note', {
      noteId,
      reason: bodyClass.reason,
      fileBytes: bodyClass.fileBytes,
      largestBlockBytes: bodyClass.largestBlockBytes
    })
  }

  const modifiedAt = writebackModifiedAt(cached.modifiedAt, local, remoteEditedAtMs)
  if (isJournalId(noteId)) {
    await writebackJournal(noteId, doc, body, cached, indexDb, modifiedAt)
  } else {
    await writebackExisting(noteId, cached, doc, body, indexDb, isLargeFileBody, modifiedAt)
    // The reminders a body's date pills derive belong to every device that
    // holds the body, and each derives its own. Only this device's edit may
    // stamp and push them. A row derived from a remote body stays unclocked,
    // so the server's row for the same id, carrying any dismissal or snooze
    // made elsewhere, applies over it instead of merging as a conflict whose
    // push-back would reset that state on the other devices.
    try {
      await syncNoteDateReminders(
        noteId,
        markdown,
        createRemindersService(getDatabase(), local ? reminderSyncHooks : undefined)
      )
    } catch (err) {
      log.warn('Failed to sync note_date reminders on write-back', { noteId, err })
    }
  }
}

/**
 * Apply, on this device, the attachment rename a body change carries.
 *
 * Isolated from the write-back's own failure path on purpose: the file is
 * already written when this runs, so a vault lookup or an unreadable
 * attachments folder must not make a successful write-back look failed.
 */
function applyAttachmentRenames(
  noteId: string,
  previousContent: string | null,
  nextContent: string
): void {
  try {
    reconcileRenamedAttachments(noteId, previousContent, nextContent, getVaultRoot())
  } catch (err) {
    log.warn('Attachment rename reconcile failed during write-back', { noteId, err })
  }
}

/**
 * Keep a version of the file a pass is about to replace, when the pass changes
 * its body.
 *
 * Bytes this module wrote on its last pass came from this doc, so replacing
 * them loses nothing the doc lacks, and typing on any device keeps the 10-word
 * rule instead of adding a version per pass. Any other bytes (an agent edit
 * through `updateNote`, a file from an earlier session) may hold text the doc
 * never took in, so they keep a version whatever the word count (#2646).
 *
 * The bodies compared are the ones in the files, so a frontmatter-only change
 * or the serializer's EOL and final-newline handling keeps none. Never throws:
 * a version that cannot be saved must not block the write.
 */
function keepVersionBeforeWriteback(
  noteId: string,
  existingRaw: string,
  fileContent: string,
  title: string
): void {
  const oldBody = splitFrontmatterBlock(existingRaw).body
  const newBody = splitFrontmatterBlock(fileContent).body
  if (oldBody === newBody) return
  try {
    const snap =
      lastWrittenHash.get(noteId) === generateContentHash(existingRaw)
        ? maybeCreateSignificantSnapshot(noteId, existingRaw, oldBody, newBody, title)
        : createSnapshot(noteId, existingRaw, title, SnapshotReasons.SIGNIFICANT)
    if (snap) log.info('Version kept before write-back', { noteId, snapshotId: snap.id })
  } catch (err) {
    log.error('Keeping a version before write-back failed', { noteId, error: err })
  }
}

async function writebackExisting(
  noteId: string,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  doc: Y.Doc,
  body: NoteBody,
  indexDb: ReturnType<typeof getIndexDatabase>,
  isLargeFileBody: boolean,
  modifiedAt: string
): Promise<void> {
  const { markdown } = body
  const relativePath = cached.path
  const absolutePath = toAbsolutePath(relativePath)

  const existingRaw = await safeRead(absolutePath)
  const parsed = existingRaw !== null ? parseNote(existingRaw, absolutePath) : null

  const { frontmatter: mergedFrontmatter, changed: frontmatterEdited } = mergeFrontmatter(
    parsed?.frontmatter ?? null,
    doc,
    body.writing
  )
  const fileContent = parsed
    ? serializeParsedNote({ ...parsed, frontmatter: mergedFrontmatter }, markdown, {
        frontmatterEdited
      })
    : serializeNote(mergedFrontmatter, markdown)

  // No byte change → no write, no mtime churn, no snapshot, no downstream signal
  if (existingRaw !== null && fileContent === existingRaw) {
    log.debug('Write-back is a no-op, skipping', { noteId })
    return
  }

  // The file changed under this doc, and the change has not been ingested yet.
  //
  // `contentHash` is what the index last read off disk, so a mismatch means an
  // edit made somewhere else — Obsidian, a script, a file another device wrote —
  // that this doc has never seen. Writing here replaces those bytes with a body
  // that predates them, and nothing keeps a copy: the edit is simply gone. It is
  // reachable from an ordinary sequence, too — edit the file while its note is
  // not the one on screen, then open that note, and the doc loaded from
  // persistence writes its older body straight over the edit.
  //
  // Skipping costs a round, not the edit. The ingest feeds the file into this
  // doc (`feedExternalEditToCrdt`) and moves the index row to the new bytes, so
  // the next pass writes from a doc that holds them. The watcher runs that
  // ingest for an edit made while the app is open. An edit made while it was
  // closed raises no event, and no launch pass re-reads a file the index
  // already lists (#2539), so the pass that finds the mismatch runs it here.
  //
  // A note whose hash was never measured used to be the exception: a tier-0
  // sidebar row, listed from `stat` alone, had nothing to compare and wrote as
  // it always did. That is the hole a stranger's vault fell through (#1909) —
  // the vault-wide CRDT sweep queued a pull for EVERY markdown note, and the
  // write-back that a remote update schedules re-serializes the whole body, so
  // a file nobody had ever opened came back rewritten. The
  // rule is now the plain one: bytes this app never read are never overwritten.
  //
  // Seeding a doc fills the column in (`CrdtProvider.seedFromMarkdown`), so
  // this refuses the write only while it is genuinely true that nothing here
  // has read the file. Opening the note is what makes it false.
  if (existingRaw !== null) {
    // A row that is not in the index at all is a different situation and not
    // this guard's: `cached` then came from canonical metadata, which means the
    // item handler applied this note and wrote this file moments ago and only
    // the projection is late (`resolveFromCanonicalMetadata`). Those bytes are
    // ours. The hole being closed is the row that EXISTS and carries no hash.
    if (!cached.contentHash && getNoteCacheById(indexDb, noteId)) {
      log.warn('Write-back skipped: the file has never been read by this app', {
        noteId,
        path: relativePath
      })
      return
    }
    const onDisk = cached.contentHash ? generateContentHash(existingRaw) : null
    if (onDisk !== null && onDisk !== cached.contentHash && parsed) {
      const ingested = await feedExternalEditToCrdt(
        noteId,
        parsed.content,
        writingFrontmatterOf(parsed.frontmatter)
      )
      // The index row moves to the new bytes only once the doc holds them.
      // Moved first, the next pass would write a doc that never saw them.
      if (ingested) {
        syncNoteToCache(
          indexDb,
          {
            id: noteId,
            path: relativePath,
            fileContent: existingRaw,
            frontmatter: parsed.frontmatter,
            parsedContent: parsed.content,
            title: cached.title,
            createdAt: cached.createdAt,
            modifiedAt: cached.modifiedAt,
            localOnly: cached.localOnly ?? false,
            emoji: cached.emoji ?? null
          },
          { isNew: false }
        )
        void flushProjectionEvents()
      }
      log.warn(
        ingested
          ? 'Write-back deferred: ingested the file that changed outside the app'
          : 'Write-back skipped: the file changed outside the app',
        { noteId, path: relativePath }
      )
      return
    }
  }

  if (existingRaw !== null)
    keepVersionBeforeWriteback(noteId, existingRaw, fileContent, cached.title)

  rememberIgnoredWrite(absolutePath)
  await atomicWrite(absolutePath, fileContent)
  lastWrittenHash.set(noteId, generateContentHash(fileContent))

  // An attachment rename that arrived in this body (#1714): the file is still
  // on this device under its old name — the blob is never re-uploaded, so the
  // encrypted manifest keeps the name it had at upload. Renaming here is what
  // makes the rename real on every device rather than only on the one that
  // performed it. Never throws; the note's own bytes are already written.
  applyAttachmentRenames(noteId, existingRaw, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: relativePath,
      fileContent,
      frontmatter: mergedFrontmatter,
      parsedContent: markdown,
      title: cached.title,
      createdAt: cached.createdAt,
      modifiedAt,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )
  void flushProjectionEvents()

  // The body genuinely changed here, so `content` has to ride along: it is what
  // makes an open editor pick up a remote edit instead of showing stale text
  // until the tab is reopened. Except when the body is large-file class, where
  // that is exactly the harm: `note.tsx` feeds `changes.content` into the
  // editor, so shipping it runs the parse this whole class exists to avoid —
  // and every window pays a structured clone of the whole body to get it.
  // The class rides along instead, so the renderer degrades to the read-only
  // view it would have shown had the file been opened fresh.
  emitNoteUpdated(emitToRenderer, {
    id: noteId,
    changes: isLargeFileBody
      ? { sizeClass: 'large-file', contentOmitted: true }
      : { content: markdown },
    source: 'sync'
  })
  log.debug('Write-back complete', { noteId })
}

async function writebackJournal(
  noteId: string,
  doc: Y.Doc,
  body: NoteBody,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  indexDb: ReturnType<typeof getIndexDatabase>,
  modifiedAt: string
): Promise<void> {
  const { markdown } = body
  const date = journalIdToDate(noteId)

  await ensureDirectory(path.dirname(getJournalPath(date)))

  const absolutePath = toAbsolutePath(cached.path)
  const existingRaw = await safeRead(absolutePath)
  const parsed = existingRaw !== null ? parseNote(existingRaw, absolutePath) : null

  const { frontmatter: mergedFrontmatter, changed: frontmatterEdited } = mergeJournalFrontmatter(
    date,
    parsed?.frontmatter ?? null,
    doc,
    body.writing
  )
  const fileContent = parsed
    ? serializeParsedNote({ ...parsed, frontmatter: mergedFrontmatter }, markdown, {
        frontmatterEdited
      })
    : serializeNote(mergedFrontmatter, markdown)

  // No byte change → no write, no mtime churn, no snapshot, no downstream signal
  if (existingRaw !== null && fileContent === existingRaw) {
    log.debug('Journal write-back is a no-op, skipping', { noteId, date })
    return
  }

  if (existingRaw !== null)
    keepVersionBeforeWriteback(noteId, existingRaw, fileContent, cached.title)

  rememberIgnoredWrite(absolutePath)
  await atomicWrite(absolutePath, fileContent)
  lastWrittenHash.set(noteId, generateContentHash(fileContent))

  // Journals hold file/image blocks like any other note — see the note path.
  applyAttachmentRenames(noteId, existingRaw, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: cached.path,
      fileContent,
      frontmatter: mergedFrontmatter,
      parsedContent: markdown,
      title: cached.title,
      createdAt: cached.createdAt,
      modifiedAt,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )
  void flushProjectionEvents()

  log.debug('Journal write-back complete', { noteId, date })
}

export async function handleSyncDeletion(noteId: string): Promise<void> {
  // Ahead of the no-row exit, because the row is exactly what this device may
  // already have dropped — a note deleted here first, then tombstoned by the
  // peer. The doc is what nothing else is left pointing at, and a doc that
  // outlives its note is what the inactive-doc sweep resurrects.
  await getCrdtProvider().purge(noteId)

  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return

  const absolutePath = toAbsolutePath(cached.path)
  deleteNoteFromCache(indexDb, noteId)
  void flushProjectionEvents()

  rememberIgnoredWrite(absolutePath)
  await deleteFile(absolutePath).catch((err) => {
    log.error('Failed to delete synced note file', { noteId, error: err })
  })

  if (!isJournalId(noteId)) {
    try {
      await clearNoteDateReminders(noteId, createRemindersService(getDatabase(), reminderSyncHooks))
    } catch (err) {
      log.warn('Failed to clear note_date reminders on sync deletion', { noteId, err })
    }
  }

  const channel = isJournalId(noteId)
    ? JournalChannels.events.ENTRY_DELETED
    : NotesChannels.events.DELETED

  emitToRenderer(channel, {
    id: noteId,
    path: cached.path,
    date: isJournalId(noteId) ? journalIdToDate(noteId) : undefined,
    source: 'sync'
  })

  log.info('Deleted from sync', { noteId })
}

interface MergedFrontmatter {
  frontmatter: NoteFrontmatter
  /** True only when the merge actually altered a frontmatter value */
  changed: boolean
}

/**
 * Merge write-back frontmatter: user keys pass through verbatim, CRDT tags
 * win when present. No Memry keys are ever injected. `changed` stays false
 * when the CRDT state matches the file, so the raw block survives verbatim.
 */
function mergeFrontmatter(
  existing: NoteFrontmatter | null,
  doc: Y.Doc,
  writing: WritingFrontmatter
): MergedFrontmatter {
  const yjsTags = getYjsTags(doc)
  const merged: NoteFrontmatter = { ...(existing ?? {}) }
  let changed = mergeWritingFrontmatter(merged, writing)
  if (yjsTags.length > 0 && !sameTags(existing?.tags, yjsTags)) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
}

function mergeJournalFrontmatter(
  date: string,
  existing: NoteFrontmatter | null,
  doc: Y.Doc,
  writing: WritingFrontmatter
): MergedFrontmatter {
  const yjsTags = getYjsTags(doc)
  const merged: NoteFrontmatter = { ...(existing ?? {}), date }
  let changed = normalizeDateValue(existing?.date) !== date
  if (mergeWritingFrontmatter(merged, writing)) changed = true
  if (yjsTags.length > 0 && !sameTags(existing?.tags, yjsTags)) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
}

/**
 * The doc's writing tools data onto `frontmatter.writing`; true when that
 * changed it. A `writing` key that is not writing tools data is the author's
 * property and is left alone, at the cost of not writing ours.
 */
function mergeWritingFrontmatter(
  frontmatter: NoteFrontmatter,
  writing: WritingFrontmatter
): boolean {
  const current = frontmatter[WRITING_FRONTMATTER_KEY]
  if (current !== undefined && !isWritingFrontmatterValue(current)) return false
  const next = toWritingFrontmatterValue(writing)
  if (isDeepStrictEqual(current, next)) return false
  if (next === undefined) delete frontmatter[WRITING_FRONTMATTER_KEY]
  else frontmatter[WRITING_FRONTMATTER_KEY] = next
  return true
}

function sameTags(existing: unknown, next: string[]): boolean {
  return (
    Array.isArray(existing) &&
    existing.length === next.length &&
    existing.every((v, i) => String(v) === next[i])
  )
}

/** YAML gives `date: 2026-07-05` back as a Date object — compare by day. */
function normalizeDateValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

function getYjsTags(doc: Y.Doc): string[] {
  const tagArray = doc.getArray('tags')
  const tags: string[] = []
  for (let i = 0; i < tagArray.length; i++) {
    const val = tagArray.get(i)
    if (typeof val === 'string') tags.push(val)
  }
  return tags
}
