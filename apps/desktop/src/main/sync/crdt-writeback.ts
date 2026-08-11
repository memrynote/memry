import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { getCrdtProvider } from './crdt-provider'
import { yDocToMarkdown } from './blocknote-converter'
import { emitNoteUpdated } from './note-events'
import { readCriticMarkupMarksFromYDoc, serializeCriticMarkup } from '@memry/shared'
import { utcNow } from '@memry/shared/utc'
import {
  atomicWrite,
  safeRead,
  fileExists,
  generateNotePath,
  generateUniquePath,
  ensureDirectory
} from '../vault/file-ops'
import {
  parseNote,
  serializeNote,
  serializeParsedNote,
  type NoteFrontmatter
} from '../vault/frontmatter'
import {
  getNotesDir,
  toRelativePath,
  toAbsolutePath,
  maybeCreateSignificantSnapshot
} from '../vault/notes'
import { getJournalPath } from '../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../vault/note-sync'
import { flushProjectionEvents } from '../projections'
import { getIndexDatabase, getDatabase } from '../database/client'
import { getNoteCacheById, getNoteCacheByPath } from '@main/database/queries/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { createRemindersService, type RemindersServiceHooks } from '@memry/app-core/reminders'
import { syncNoteDateReminders, clearNoteDateReminders } from '../notes/note-date-reminders'
import { deleteFile } from '../vault/file-ops'
import { NotesChannels, JournalChannels } from '@memry/contracts/ipc-channels'
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

const IGNORED_WRITE_TTL_MS = 5000

interface PendingWriteback {
  timer: ReturnType<typeof setTimeout>
  doc: Y.Doc
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
    lastError: null
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

export function isWritebackIgnored(absolutePath: string): boolean {
  const now = Date.now()
  for (const [p, ts] of ignoredWrites) {
    if (now - ts >= IGNORED_WRITE_TTL_MS) ignoredWrites.delete(p)
  }
  const ts = ignoredWrites.get(absolutePath)
  if (!ts) return false
  return now - ts < IGNORED_WRITE_TTL_MS
}

export function clearWritebackIgnore(_absolutePath: string): void {
  // no-op: auto-evicted by TTL in isWritebackIgnored
}

export function markWritebackIgnored(absolutePath: string): void {
  ignoredWrites.set(absolutePath, Date.now())
}

const CONCURRENT_EDIT_WINDOW_MS = 2000

export function recordNetworkUpdate(noteId: string): void {
  lastNetworkUpdateMs.set(noteId, Date.now())
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

/** Runs a pass and records what it cost, which is what paces the next one. */
async function runWriteback(noteId: string, doc: Y.Doc): Promise<void> {
  const startedAt = Date.now()
  try {
    await performWriteback(noteId, doc)
  } finally {
    const finishedAt = Date.now()
    lastWritebackCost.set(noteId, { finishedAt, durationMs: finishedAt - startedAt })
  }
}

export function scheduleWriteback(noteId: string, doc: Y.Doc): void {
  const existing = pendingTimers.get(noteId)
  if (existing) clearTimeout(existing.timer)
  updateDebugState(noteId, {
    pending: true,
    scheduledCount: (debugState.get(noteId)?.scheduledCount ?? 0) + 1,
    lastError: null
  })

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId)
    inFlightWritebacks.add(noteId)
    runWriteback(noteId, doc)
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

  pendingTimers.set(noteId, { timer, doc })
}

export function cancelPendingWritebacks(): void {
  for (const { timer } of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
  lastWritebackCost.clear()
}

export async function flushPendingWritebacks(): Promise<void> {
  const pending = Array.from(pendingTimers.entries())
  pendingTimers.clear()
  for (const [, { timer }] of pending) clearTimeout(timer)
  await Promise.all(
    pending.map(([noteId, { doc }]) =>
      runWriteback(noteId, doc).catch((err) => {
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
 * gap used to see no cache row, take the `writebackNewNote` branch, and
 * overwrite the just-applied title and path with the Y.Doc meta title (the
 * literal 'Untitled' a note is born with), producing an "Untitled" note whose
 * content is correct on every receiving device.
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

async function performWriteback(noteId: string, doc: Y.Doc): Promise<void> {
  const plainMarkdown = await yDocToMarkdown(doc)
  const markdown =
    plainMarkdown === null
      ? null
      : serializeCriticMarkup(plainMarkdown, readCriticMarkupMarksFromYDoc(doc))
  updateDebugState(noteId, {
    pending: false,
    performedCount: (debugState.get(noteId)?.performedCount ?? 0) + 1,
    lastMarkdown: markdown,
    lastError: null
  })
  if (markdown === null) {
    log.warn('Conversion returned null, keeping stale file', { noteId })
    // Silent editor/file divergence — a serializer regression must show on
    // dashboards. Throttled: fires per debounce while the user keeps typing.
    if (shouldEmitThrottled(`writeback_conversion_null:${noteId}`)) {
      trackMainLog('error', { scope: 'CrdtWriteback', action: 'conversion_null' })
    }
    return
  }

  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId) ?? resolveFromCanonicalMetadata(noteId)

  if (isJournalId(noteId)) {
    await writebackJournal(noteId, doc, markdown, cached, indexDb)
  } else {
    if (cached) {
      await writebackExisting(noteId, cached, doc, markdown, indexDb)
    } else {
      await writebackNewNote(noteId, doc, markdown, indexDb)
    }
    try {
      await syncNoteDateReminders(
        noteId,
        markdown,
        createRemindersService(getDatabase(), reminderSyncHooks)
      )
    } catch (err) {
      log.warn('Failed to sync note_date reminders on write-back', { noteId, err })
    }
  }
}

async function writebackExisting(
  noteId: string,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const relativePath = cached.path
  const absolutePath = toAbsolutePath(relativePath)

  const existingRaw = await safeRead(absolutePath)
  const parsed = existingRaw !== null ? parseNote(existingRaw, absolutePath) : null

  const { frontmatter: mergedFrontmatter, changed: frontmatterEdited } = mergeFrontmatter(
    parsed?.frontmatter ?? null,
    doc
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

  if (existingRaw !== null && parsed) {
    try {
      const snap = maybeCreateSignificantSnapshot(
        noteId,
        existingRaw,
        parsed.content,
        markdown,
        cached.title
      )
      if (snap) log.info('Snapshot created during writeback', { noteId, snapshotId: snap.id })
    } catch (err) {
      log.error('Snapshot creation failed during writeback', { noteId, error: err })
    }
  }

  ignoredWrites.set(absolutePath, Date.now())
  await atomicWrite(absolutePath, fileContent)

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
      modifiedAt: utcNow(),
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )
  void flushProjectionEvents()

  // The body genuinely changed here, so `content` has to ride along: it is what
  // makes an open editor pick up a remote edit instead of showing stale text
  // until the tab is reopened.
  emitNoteUpdated(emitToRenderer, {
    id: noteId,
    changes: { content: markdown },
    source: 'sync'
  })
  log.debug('Write-back complete', { noteId })
}

async function writebackNewNote(
  noteId: string,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const meta = doc.getMap('meta')
  const title = (meta.get('title') as string) || 'Untitled'

  const notesDir = getNotesDir()
  // Guard against filename collisions: distinct titles can sanitize to the same
  // basename (e.g. `Report #1` and `Report 1`), which would otherwise overwrite
  // an existing note's file and orphan an index row. Mirrors createNote.
  const absolutePath = await generateUniquePath(generateNotePath(notesDir, title))
  const relativePath = toRelativePath(absolutePath)

  const { frontmatter } = mergeFrontmatter(null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  ignoredWrites.set(absolutePath, Date.now())
  await atomicWrite(absolutePath, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: relativePath,
      fileContent,
      frontmatter,
      parsedContent: markdown,
      title,
      createdAt: (meta.get('date') as string) || utcNow(),
      modifiedAt: utcNow()
    },
    { isNew: true }
  )
  void flushProjectionEvents()

  emitToRenderer(NotesChannels.events.CREATED, {
    note: { id: noteId, path: relativePath, title },
    source: 'sync'
  })

  log.info('Created new note from sync', { noteId, title })
}

async function writebackJournal(
  noteId: string,
  doc: Y.Doc,
  markdown: string,
  cached: ReturnType<typeof getNoteCacheById> | undefined,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const date = journalIdToDate(noteId)
  const journalPath = getJournalPath(date)

  await ensureDirectory(path.dirname(journalPath))

  if (cached) {
    const absolutePath = toAbsolutePath(cached.path)
    const existingRaw = await safeRead(absolutePath)
    const parsed = existingRaw !== null ? parseNote(existingRaw, absolutePath) : null

    const { frontmatter: mergedFrontmatter, changed: frontmatterEdited } = mergeJournalFrontmatter(
      date,
      parsed?.frontmatter ?? null,
      doc
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

    if (existingRaw !== null && parsed) {
      try {
        const snap = maybeCreateSignificantSnapshot(
          noteId,
          existingRaw,
          parsed.content,
          markdown,
          cached.title
        )
        if (snap)
          log.info('Journal snapshot created during writeback', { noteId, snapshotId: snap.id })
      } catch (err) {
        log.error('Journal snapshot creation failed during writeback', { noteId, error: err })
      }
    }

    ignoredWrites.set(absolutePath, Date.now())
    await atomicWrite(absolutePath, fileContent)

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
        modifiedAt: utcNow(),
        localOnly: cached.localOnly ?? false,
        emoji: cached.emoji ?? null
      },
      { isNew: false }
    )
    void flushProjectionEvents()

    log.debug('Journal write-back complete', { noteId, date })
    return
  }

  if (await fileExists(journalPath)) {
    // File identity lives in the sidecar: a cache row at this path owned by a
    // different (or unknown) note means the date file is already claimed
    const rowAtPath = getNoteCacheByPath(indexDb, toRelativePath(journalPath))
    if (rowAtPath?.id !== noteId) {
      await handleJournalCollision(noteId, date, rowAtPath?.id ?? 'unknown', doc, markdown, indexDb)
      return
    }
  }

  const relativePath = toRelativePath(journalPath)
  const { frontmatter } = mergeJournalFrontmatter(date, null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  ignoredWrites.set(journalPath, Date.now())
  await atomicWrite(journalPath, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: relativePath,
      fileContent,
      frontmatter,
      parsedContent: markdown,
      title: path.basename(journalPath, '.md'),
      createdAt: utcNow(),
      modifiedAt: utcNow()
    },
    { isNew: true }
  )
  void flushProjectionEvents()

  emitToRenderer(JournalChannels.events.ENTRY_CREATED, {
    date,
    source: 'sync'
  })

  log.info('Created journal from sync', { noteId, date })
}

async function handleJournalCollision(
  incomingId: string,
  date: string,
  existingId: string,
  doc: Y.Doc,
  markdown: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): Promise<void> {
  const shortId = incomingId.slice(0, 8)
  const collisionFilename = `${date}-${shortId}.md`
  const journalDir = path.dirname(getJournalPath(date))
  const collisionPath = path.join(journalDir, collisionFilename)
  const relativePath = toRelativePath(collisionPath)

  const { frontmatter } = mergeJournalFrontmatter(date, null, doc)
  const fileContent = serializeNote(frontmatter, markdown)

  await ensureDirectory(journalDir)
  ignoredWrites.set(collisionPath, Date.now())
  await atomicWrite(collisionPath, fileContent)

  syncNoteToCache(
    indexDb,
    {
      id: incomingId,
      path: relativePath,
      fileContent,
      frontmatter,
      parsedContent: markdown,
      title: path.basename(collisionPath, '.md'),
      createdAt: utcNow(),
      modifiedAt: utcNow()
    },
    { isNew: true }
  )
  void flushProjectionEvents()

  emitToRenderer('sync:journal-conflict', {
    date,
    incomingId,
    existingId,
    collisionPath: relativePath
  })

  log.warn('Journal date collision', { date, incomingId, existingId, collisionPath: relativePath })
}

export async function handleSyncDeletion(noteId: string): Promise<void> {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return

  const absolutePath = toAbsolutePath(cached.path)
  deleteNoteFromCache(indexDb, noteId)
  void flushProjectionEvents()

  ignoredWrites.set(absolutePath, Date.now())
  await deleteFile(absolutePath).catch((err) => {
    log.error('Failed to delete synced note file', { noteId, error: err })
  })

  await getCrdtProvider().close(noteId)

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
function mergeFrontmatter(existing: NoteFrontmatter | null, doc: Y.Doc): MergedFrontmatter {
  const yjsTags = getYjsTags(doc)
  const merged: NoteFrontmatter = { ...(existing ?? {}) }
  let changed = false
  if (yjsTags.length > 0 && !sameTags(existing?.tags, yjsTags)) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
}

function mergeJournalFrontmatter(
  date: string,
  existing: NoteFrontmatter | null,
  doc: Y.Doc
): MergedFrontmatter {
  const yjsTags = getYjsTags(doc)
  const merged: NoteFrontmatter = { ...(existing ?? {}), date }
  let changed = normalizeDateValue(existing?.date) !== date
  if (yjsTags.length > 0 && !sameTags(existing?.tags, yjsTags)) {
    merged.tags = yjsTags
    changed = true
  }
  return { frontmatter: merged, changed }
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
