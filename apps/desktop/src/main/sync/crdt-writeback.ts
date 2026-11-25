import { AsyncLocalStorage } from 'node:async_hooks'
import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { completeWithin } from '../shutdown-sequence'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { getCrdtProvider } from './crdt-provider'
import { ingestOfflineEdit, ingestOutsideEditFirst } from './crdt-writeback-ingest'
import { registerCrdtWritebackPort } from './crdt-writeback-port'
import { networkUpdateCount, resetNetworkUpdateState } from './crdt-network-update'
import { owesFileBody } from './crdt-owed-file-body'
import { recordUnchangedFile, writeDocWithBaseline } from './writeback-baseline'
import type { SourceRestoreOutcome } from './blocknote-converter'
import type { NoteBody } from './writing-markdown'
import { applyCriticMarkMoves } from './critic-mark-anchors'
import { readyWritebackConverter } from './converter-worker-bridge'
import { emitNoteUpdated } from '@memry/sync-client/note-events'
import { mergeFrontmatter, mergeJournalFrontmatter } from './crdt-writeback-frontmatter'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { laterEditTime, writebackModifiedAt } from './crdt-writeback-edit-time'
import { atomicWrite, ensureDirectory } from '../vault/file-ops'
import { appWriteCount, recordAppWrite, resetAppWrites } from '../vault/app-writes'
import { readVaultFile, refuseOutsideVaultSync } from '../lib/paths'
import { runWithLockedWritesAllowed } from '../vault-locks/registry'
import {
  generateContentHash,
  parseNote,
  serializeNote,
  serializeParsedNote
} from '../vault/frontmatter'
import { splitFrontmatterBlock } from '@memry/shared/frontmatter-split'
import { getVaultRoot, toAbsolutePath } from '../vault/notes-io'
import { createSnapshot, maybeCreateSignificantSnapshot } from '../vault/notes-versions'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getJournalPath } from '../vault/journal'
import { syncNoteToCache, refusesCaseTwinFile } from '../vault/note-sync'
import { reconcileRenamedAttachments } from '../vault/attachment-rename-reconcile'
import { placeLinkedDownloads } from './attachment-files'
import { flushProjectionEvents } from '../projections'
import { getIndexDatabase, getDatabase } from '../database/client'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { createRemindersService, type RemindersServiceHooks } from '@memry/app-core/reminders'
import { syncNoteDateReminders } from '../notes/note-date-reminders'
import { CRDT_EVENTS, type CrdtWriteBackFailedEvent } from '@memry/contracts/ipc-crdt'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import path from 'path'
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
/** Closed notes whose doc a failed body write left ahead of the file (`retryWriteback`). */
const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>()
/** The turn (a pass or a frontmatter writer) running, or queued behind a running one, for each note. */
const runningPasses = new Map<string, Promise<unknown>>()
/** Repairs that run at the start of a note's next turn (`repairAfterRunningTurn`). */
const pendingRepairs = new Map<string, Array<() => Promise<void>>>()
/** Work a flush waits for after the turns (`holdFlushUntil`), to the label the log names it by. */
const heldWork = new Map<Promise<unknown>, string>()
/**
 * How long a flush waits for held work. A held journal create waits on the
 * projection lane, which a stuck projection holds for good, and a quit, a vault
 * close and a journal format change all flush.
 */
const HELD_WORK_CAP_MS = 1_500
/**
 * Bumped by `cancelWriteback`. A pass that was already converting when its
 * note was deleted sees the change and does not write the file back.
 */
const cancelGenerations = new Map<string, number>()
/** True while a flush runs before a quit or a vault close. */
let flushing = false
/** Notes whose last pass failed and whose user has been told so. */
const failingWritebacks = new Set<string>()
/** Note id to the content hash of the file bytes this module last wrote for it. */
const lastWrittenHash = new Map<string, string>()
/** Note id to the review marks its file could not hold, as last logged. */
const unplacedCriticMarks = new Map<string, string>()

/**
 * True while this note's on-disk markdown is known to be behind the live doc —
 * a writeback is debounced or mid-write. Readers that treat the file as the
 * source of truth (see tasks/reconcile-markdown-tasks) must stand down in this
 * window, or they would "restore" state the user just changed in the app.
 */
export function hasPendingWriteback(noteId: string): boolean {
  return pendingTimers.has(noteId) || runningPasses.has(noteId)
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
 * Runs a pass once the note's previous pass has finished.
 *
 * One pass per note at a time. A pass reads the note's row, converts on the
 * converter worker (seconds on a cold start), then writes and records the new
 * hash. A second pass that started meanwhile read the row from before that
 * write, took the first pass's own file for an edit made outside the app, and
 * fed it back into the doc, losing what the user typed in between.
 */
async function runWriteback(
  noteId: string,
  doc: Y.Doc,
  local: boolean,
  remoteEditedAtMs: number | undefined
): Promise<void> {
  await takeWritebackTurn(noteId, () => runPass(noteId, doc, local, remoteEditedAtMs))
}

/** Whether a turn of this note (a pass or a frontmatter writer) is running or queued. */
export function hasWritebackTurn(noteId: string): boolean {
  return runningPasses.has(noteId)
}

/**
 * Runs `run` once the note's earlier turns have settled. A pass writes back
 * the frontmatter it read, and a writer that changes only frontmatter (tags,
 * properties) leaves the doc as it was, so the re-arm after a pass cannot see
 * it: landing between a pass's read and its write lost it (#5472). Those
 * writers take a turn here too. `run` must not wait on a pass of the note.
 */
export function takeWritebackTurn<T>(noteId: string, run: () => Promise<T>): Promise<T> {
  const token = {}
  const held = new Map(heldTurns.getStore())
  held.set(noteId, token)
  const turn = (runningPasses.get(noteId) ?? Promise.resolve())
    // The previous turn reported its own failure; this one runs regardless.
    .catch(() => {})
    .then(async () => {
      await runRepairs(noteId)
      runningTurns.set(noteId, token)
      try {
        return await heldTurns.run(held, run)
      } finally {
        if (runningTurns.get(noteId) === token) runningTurns.delete(noteId)
      }
    })
  runningPasses.set(noteId, turn)
  const clear = (): void => {
    if (runningPasses.get(noteId) === turn) runningPasses.delete(noteId)
  }
  turn.then(clear, clear)
  return turn
}

/**
 * The turns the running code is inside of, by note, and the turn each note
 * runs now. A timer armed inside a turn inherits its context after the turn
 * ended, so only a match with the running turn counts (`insideWritebackTurn`).
 */
const heldTurns = new AsyncLocalStorage<ReadonlyMap<string, object>>()
const runningTurns = new Map<string, object>()

export function insideWritebackTurn(noteId: string): boolean {
  const token = heldTurns.getStore()?.get(noteId)
  return token !== undefined && runningTurns.get(noteId) === token
}

/**
 * Runs `repair` as soon as the note's running turn ends, ahead of the turns
 * already queued behind it. A writer that cannot wait for a turn (the sync
 * apply's frontmatter rewrite) repairs what a pass that read the file before
 * it wrote back, before a later local edit builds on that file (#5479).
 * `repair` reports its own failure and must not wait on a pass of the note.
 */
export function repairAfterRunningTurn(noteId: string, repair: () => Promise<void>): void {
  const queued = pendingRepairs.get(noteId)
  if (queued) queued.push(repair)
  else pendingRepairs.set(noteId, [repair])
  void takeWritebackTurn(noteId, async () => {})
}

/**
 * Makes a flush wait for `work` after the turns, for up to `HELD_WORK_CAP_MS`.
 * For a writer's step that must land before a quit but can run outside a turn:
 * a new journal day's sync enqueue (`writeJournalEntryCreate`). Call it before
 * the writer starts, so a flush that begins meanwhile finds it. `label` names
 * the work in the log when a flush stops waiting for it. `work` must not wait
 * on the CRDT store, since a flush runs while the store can be stuck (#5475).
 */
export function holdFlushUntil(work: Promise<unknown>, label: string): void {
  heldWork.set(work, label)
  const release = (): void => void heldWork.delete(work)
  work.then(release, release)
}

async function runRepairs(noteId: string): Promise<void> {
  const queued = pendingRepairs.get(noteId)
  if (!queued) return
  pendingRepairs.delete(noteId)
  for (const repair of queued) await repair()
}

/** Runs a pass and records what it cost, which is what paces the next one. */
async function runPass(
  noteId: string,
  doc: Y.Doc,
  local: boolean,
  remoteEditedAtMs: number | undefined,
  ownDoc = false
): Promise<void> {
  const startedAt = Date.now()
  try {
    const serialized = ownDoc ? doc : resolveWritebackDoc(noteId, doc)
    await performWriteback(noteId, serialized, local, remoteEditedAtMs)
    failingWritebacks.delete(noteId)
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
    runWriteback(noteId, doc, local, pendingRemoteEditedAtMs).catch((err: unknown) =>
      reportWritebackFailure(noteId, err)
    )
  }, writebackDelayMs(noteId))

  pendingTimers.set(noteId, { timer, doc, local, remoteEditedAtMs: pendingRemoteEditedAtMs })
}

/**
 * A failed write-back means typed content was NOT persisted to disk. The user
 * hears of it once per run of failed passes for the note, not on every pass a
 * deterministic fault (a restore that always throws, a file another program
 * holds) fails again; the pass that lands ends the run.
 */
function reportWritebackFailure(noteId: string, err: unknown): void {
  updateDebugState(noteId, {
    pending: false,
    lastError: err instanceof Error ? err.message : String(err)
  })
  // Throttled: a persistent disk fault would otherwise fire per debounce.
  if (shouldEmitThrottled(`note_writeback_error:${noteId}`)) {
    trackMainError('notes', 'note_writeback', err)
  }
  if (failingWritebacks.has(noteId)) {
    log.debug('Write-back failed again', { noteId, error: err })
    return
  }
  failingWritebacks.add(noteId)
  log.error('Write-back failed', { noteId, error: err })
  const event: CrdtWriteBackFailedEvent = { noteId }
  try {
    const title = getNoteCacheById(getIndexDatabase(), noteId)?.title
    if (title) event.title = title
  } catch (lookupErr) {
    log.warn('Write-back failure notice: note title lookup failed', { noteId, error: lookupErr })
  }
  emitToRenderer(CRDT_EVENTS.WRITE_BACK_FAILED, event)
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
  cancelGenerations.set(noteId, (cancelGenerations.get(noteId) ?? 0) + 1)
  lastWritebackCost.delete(noteId)
  lastWrittenHash.delete(noteId)
  debugState.delete(noteId)
  failingWritebacks.delete(noteId)
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
  await runWriteback(noteId, doc, pending?.local === true, pending?.remoteEditedAtMs)
}

/**
 * Run this note's armed pass now, if one is armed, so a caller that reads the
 * file back right after a write reports what the file keeps (#2615). A failed
 * pass is reported as a timed one is, not thrown: the file then holds what the
 * write left.
 */
export async function settleWriteback(noteId: string): Promise<void> {
  const pending = pendingTimers.get(noteId)
  if (!pending) return
  await writebackNow(noteId, pending.doc).catch((err: unknown) =>
    reportWritebackFailure(noteId, err)
  )
}

/**
 * Before a close destroys the note's doc: waits for the note's running turn,
 * so a pass that serialized `doc` records its file while `doc` is still the
 * note's. With `runArmed` (the store does not hold `doc`) it then runs the
 * armed pass against `doc` itself inside the note's turn: once destroyed,
 * nothing else writes what the store missed (#5698, `recordDocFile`). A close
 * inside the note's own turn (a writer's feed closing the doc it opened) runs
 * the pass in place: waiting for the turn would wait for itself. Never
 * throws; a failed pass is reported as a timed one is.
 */
export async function writeBackBeforeClose(
  noteId: string,
  doc: Y.Doc,
  runArmed: boolean
): Promise<void> {
  const pending = runArmed ? pendingTimers.get(noteId) : undefined
  if (pending) {
    clearTimeout(pending.timer)
    pendingTimers.delete(noteId)
  }
  const pass = async (): Promise<void> => {
    if (pending) await runPass(noteId, doc, pending.local, pending.remoteEditedAtMs, true)
  }
  const done = insideWritebackTurn(noteId)
    ? pass()
    : pending || runningPasses.has(noteId)
      ? takeWritebackTurn(noteId, pass)
      : Promise.resolve()
  await done.catch((err: unknown) => reportWritebackFailure(noteId, err))
}

export function cancelPendingWritebacks(): void {
  for (const { timer } of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
  for (const timer of pendingRetries.values()) clearTimeout(timer)
  pendingRetries.clear()
  lastWritebackCost.clear()
}

/** Whether a pass is armed: a debounced one, or a closed note's retry. */
export function hasArmedWritebacks(): boolean {
  return pendingTimers.size > 0 || pendingRetries.size > 0
}

/**
 * Sizes of the module-level maps. Diagnostics only — the growth of these maps
 * is the bug this bookkeeping exists to keep regression-testable, and
 * `wasRecentNetworkUpdate` cannot distinguish "entry expired" from "entry
 * evicted", so a leak is otherwise unobservable.
 */
export function getWritebackStateSizes(): {
  appWrites: number
  networkUpdates: number
  lastWrittenHashes: number
  debugState: number
} {
  return {
    appWrites: appWriteCount(),
    networkUpdates: networkUpdateCount(),
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
 *
 * `destroy()` flushes until no pass is armed and drops its docs without an
 * await in between, so none is armed here. The cancel guards that: left
 * armed, a pass would fire into whichever vault is open by then, and a journal
 * day has the same id in every vault.
 */
export function resetWritebackState(): void {
  if (hasArmedWritebacks()) {
    log.warn('Vault teardown dropped armed write-backs; their docs are in the CRDT store', {
      noteIds: [...pendingTimers.keys(), ...pendingRetries.keys()]
    })
  }
  cancelPendingWritebacks()
  resetAppWrites()
  resetNetworkUpdateState()
  lastWrittenHash.clear()
  pendingRepairs.clear()
  cancelGenerations.clear()
  debugState.clear()
  failingWritebacks.clear()
  unplacedCriticMarks.clear()
}

export async function flushPendingWritebacks(): Promise<void> {
  flushing = true
  try {
    await flushAll()
  } finally {
    flushing = false
  }
}

async function flushAll(): Promise<void> {
  // Until none is armed: a keystroke that lands while a pass converts arms
  // the next one, and a vault close that left it armed would drop it.
  do {
    const pending = Array.from(pendingTimers.entries())
    pendingTimers.clear()
    for (const [, { timer }] of pending) clearTimeout(timer)
    const retries = Array.from(pendingRetries.entries())
    pendingRetries.clear()
    for (const [, timer] of retries) clearTimeout(timer)
    // Passes already running are awaited too: one converting on the worker is
    // seconds from its write, and a quit that skipped it would lose that edit.
    const running = Array.from(runningPasses.values(), (pass) => pass.catch(() => {}))
    await Promise.all([
      ...running,
      ...pending.map(([noteId, { doc, local, remoteEditedAtMs }]) =>
        runWriteback(noteId, doc, local, remoteEditedAtMs).catch((err: unknown) => {
          log.error('Write-back failed during shutdown flush', { noteId, error: err })
        })
      ),
      ...retries.map(([noteId]) => materializeRetry(noteId))
    ])
  } while (hasArmedWritebacks())
  if (heldWork.size === 0) return
  // Its owner reports a failure; the flush only waits for it.
  const held = Promise.all(Array.from(heldWork.keys(), (work) => work.catch(() => {})))
  if (!(await completeWithin(held, HELD_WORK_CAP_MS))) {
    log.warn('Flush stopped waiting for held work', { held: Array.from(heldWork.values()) })
  }
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
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the intermediate unknown bridges two types that do not overlap; the target type is the contract of this value; loosely typed value (unknown, column or error) named as its contract type; a runtime guard would change behavior
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
  // Ready before the note row is read, so the row below is as fresh as it
  // was before the converter became lazy: past this line nothing awaits until
  // the serialization itself. The conversion runs on the write-back worker,
  // off the main thread (converter-worker-bridge.ts).
  const convert = await readyWritebackConverter({ mainUnlessReady: flushing })
  const generation = cancelGenerations.get(noteId)
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
  // A binary note's file is its downloaded blob, and its row names the blob's
  // type. The server holds a CRDT body for binary notes too, so a fresh device
  // settles one into a doc; writing it would put markdown over the image, PDF
  // or recording and turn the row into a markdown note (#5412). A shipped
  // build already saved some of these rows as markdown; `isBinaryNoteRow`
  // reads the path's type too until the index walk repairs the row.
  if (isBinaryNoteRow(cached)) {
    updateDebugState(noteId, { pending: false })
    log.debug('Write-back skipped: binary note', { noteId, fileType: cached.fileType })
    return
  }
  // A file linked outside the vault is neither read nor written over (#2804).
  refuseOutsideVaultSync(getVaultRoot(), cached.path)

  // Fail closed. If the doc holds a node type this build has no schema spec
  // for, every serialization of it is missing that node — writing the result
  // would make the loss the file's permanent content, and the next index pass
  // would push it to every other device. Keeping the file costs the user a
  // stale body until a build that knows the type runs; writing costs them the
  // content.
  const converted = Y.encodeStateVector(doc)
  const conversion = await convert(doc, cached.path, async () => {
    const raw = await readVaultFile(getVaultRoot(), cached.path)
    return raw === null ? null : splitFrontmatterBlock(raw).body
  })
  if (cancelGenerations.get(noteId) !== generation) {
    updateDebugState(noteId, { pending: false })
    log.debug('Write-back dropped: the note was cancelled while it converted', { noteId })
    return
  }
  if (conversion.kind === 'unrepresentable') {
    const unrepresentable = conversion.nodes
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

  const { body, sourceRestore } = conversion
  if (sourceRestore) updateDebugState(noteId, { sourceRestore })
  const restore = { outcome: sourceRestore }
  // The file is kept, and the pass fails the way a failed read does: the
  // failure telemetry hears of it, the user gets one notice for the note
  // (`reportWritebackFailure`), and the next update retries.
  if (restore.outcome === 'restore-threw' || restore.outcome === 'file-unreadable') {
    throw new Error(
      `The author's spelling could not be restored (${restore.outcome}); kept the file`
    )
  }
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
  // returns above, and a file shared with a case twin, which the take never
  // reads: `refusesCaseTwinFile`, #5297) or a note with no index row the take
  // can read: each flush would queue the next one.
  if (owesFileBody(noteId)) {
    if (indexed && !refusesCaseTwinFile(getVaultRoot(), cached.path, noteId))
      getCrdtProvider().recordOwedFullState(noteId)
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
  const journal = isJournalId(noteId)
  const holdsBody = journal
    ? await writebackJournal(noteId, doc, body, cached, indexDb, modifiedAt)
    : await writebackExisting(noteId, cached, doc, body, indexDb, isLargeFileBody, modifiedAt)
  settleCriticMarks(noteId, doc, body.criticMarks, local && holdsBody)
  if (!journal) {
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
  // A body writer that fed the doc while this pass converted wrote its file
  // first, and this pass then wrote the older body over it (REVIEW-5465). Doc
  // updates from the editor or the network arm their own pass; a feed does not.
  if (!pendingTimers.has(noteId) && !Buffer.from(converted).equals(Y.encodeStateVector(doc))) {
    scheduleWriteback(noteId, doc, 'local')
  }
}

/**
 * What became of the doc's review marks in the body just written. The doc
 * takes the marks the pass moved only once the file holds them, and only on
 * the device whose edit the pass wrote: every other device places the same
 * marks in its own file and gets the doc's copy from that one, so two devices
 * do not both rewrite them (critic-mark-anchors.ts).
 */
function settleCriticMarks(
  noteId: string,
  doc: Y.Doc,
  marks: NoteBody['criticMarks'],
  movesDoc: boolean
): void {
  if (marks.orphaned.length > 0) {
    log.warn('Comments whose text was deleted stay as a point where it was', {
      noteId,
      markIds: marks.orphaned
    })
  }
  const unplaced = marks.unplaced.join(',')
  if (unplaced !== (unplacedCriticMarks.get(noteId) ?? '')) {
    if (unplaced) {
      unplacedCriticMarks.set(noteId, unplaced)
      log.warn('Review marks the file cannot hold stay in the doc only', {
        noteId,
        markIds: marks.unplaced
      })
    } else {
      unplacedCriticMarks.delete(noteId)
    }
  }
  if (movesDoc) applyCriticMarkMoves(doc, marks.moves)
}

/**
 * Apply, on this device, the attachment rename a body change carries, and put
 * files that downloaded before this body where it links them (#2755).
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
    const vaultRoot = getVaultRoot()
    reconcileRenamedAttachments(noteId, previousContent, nextContent, vaultRoot)
    void placeLinkedDownloads(getDatabase(), vaultRoot, noteId).catch((err: unknown) =>
      log.warn('Placing linked downloads failed during write-back', { noteId, err })
    )
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

/** Resolves true when the file holds `body` afterwards: written now, or already. */
async function writebackExisting(
  noteId: string,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  doc: Y.Doc,
  body: NoteBody,
  indexDb: ReturnType<typeof getIndexDatabase>,
  isLargeFileBody: boolean,
  modifiedAt: string
): Promise<boolean> {
  const { markdown } = body
  const relativePath = cached.path
  const absolutePath = toAbsolutePath(relativePath)

  const existingRaw = await readVaultFile(getVaultRoot(), cached.path)
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
    recordUnchangedFile(indexDb, noteId, cached, existingRaw, doc, getCrdtProvider())
    log.debug('Write-back is a no-op, skipping', { noteId })
    return true
  }

  // The file changed under this doc, and the change has not been ingested yet.
  //
  // The baseline (`writeback-baseline.ts`) is the bytes this doc holds, so a
  // mismatch means an edit made somewhere else — Obsidian, a script, a file
  // another device wrote — that this doc has never seen. Writing here replaces those bytes with a body
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
  // already lists (#2539), so the pass that finds the mismatch runs it here,
  // keeping the body this doc serialized as a version first.
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
      return false
    }
    if (
      parsed &&
      (await ingestOutsideEditFirst(indexDb, noteId, cached, existingRaw, parsed, {
        body: markdown,
        file: fileContent
      }))
    ) {
      return false
    }
  }

  if (existingRaw !== null)
    keepVersionBeforeWriteback(noteId, existingRaw, fileContent, cached.title)

  // A locked note's doc only ever takes another device's edits (local updates
  // are refused at crdt:apply-update), so its write-back is allowed (#2606).
  await writeDocWithBaseline(
    indexDb,
    noteId,
    fileContent,
    async () => {
      const landed = recordAppWrite(absolutePath, fileContent)
      await runWithLockedWritesAllowed(() => atomicWrite(absolutePath, fileContent))
      landed()
    },
    doc,
    getCrdtProvider()
  )
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
    { isNew: false, source: 'sync' }
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
  return true
}

/** Resolves true when the file holds `body` afterwards: written now, or already. */
async function writebackJournal(
  noteId: string,
  doc: Y.Doc,
  body: NoteBody,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  indexDb: ReturnType<typeof getIndexDatabase>,
  modifiedAt: string
): Promise<boolean> {
  const { markdown } = body
  const date = journalIdToDate(noteId)

  await ensureDirectory(path.dirname(getJournalPath(date)))

  const absolutePath = toAbsolutePath(cached.path)
  const existingRaw = await readVaultFile(getVaultRoot(), cached.path)
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
    recordUnchangedFile(indexDb, noteId, cached, existingRaw, doc, getCrdtProvider())
    log.debug('Journal write-back is a no-op, skipping', { noteId, date })
    return true
  }

  // A journal file edited outside the app is taken in the same way as a note's.
  if (
    existingRaw !== null &&
    parsed &&
    (await ingestOutsideEditFirst(indexDb, noteId, cached, existingRaw, parsed, {
      body: markdown,
      file: fileContent
    }))
  ) {
    return false
  }

  if (existingRaw !== null)
    keepVersionBeforeWriteback(noteId, existingRaw, fileContent, cached.title)

  // A locked note's doc only ever takes another device's edits (local updates
  // are refused at crdt:apply-update), so its write-back is allowed (#2606).
  await writeDocWithBaseline(
    indexDb,
    noteId,
    fileContent,
    async () => {
      const landed = recordAppWrite(absolutePath, fileContent)
      await runWithLockedWritesAllowed(() => atomicWrite(absolutePath, fileContent))
      landed()
    },
    doc,
    getCrdtProvider()
  )
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
    { isNew: false, source: 'sync' }
  )
  void flushProjectionEvents()

  log.debug('Journal write-back complete', { noteId, date })
  return true
}

/**
 * A body writer fed the doc and then failed to write the file
 * (`landBodyEdit`): the next pass writes it. A closed doc is opened for it.
 */
function retryWriteback(noteId: string): void {
  const doc = getCrdtProvider().getDoc(noteId)
  if (doc) return scheduleWriteback(noteId, doc, 'local')
  clearTimeout(pendingRetries.get(noteId))
  const timer = setTimeout(() => {
    pendingRetries.delete(noteId)
    void materializeRetry(noteId)
  }, writebackDelayMs(noteId))
  pendingRetries.set(noteId, timer)
}

async function materializeRetry(noteId: string): Promise<void> {
  try {
    await getCrdtProvider().materialize(noteId)
  } catch (err) {
    reportWritebackFailure(noteId, err)
  }
}

registerCrdtWritebackPort({
  ingestOfflineEdit,
  retryWriteback,
  scheduleWriteback,
  cancelWriteback,
  flushPendingWritebacks,
  hasArmedWritebacks,
  resetWritebackState,
  insideWritebackTurn,
  writeBackBeforeClose,
  writebackNow
})
