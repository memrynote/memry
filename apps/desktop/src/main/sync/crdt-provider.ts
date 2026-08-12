import * as Y from 'yjs'
import path from 'path'
import { rmSync } from 'fs'
import { app, BrowserWindow } from 'electron'
import { CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById } from '@main/database/queries/notes'
import type { CrdtUpdateQueue } from './crdt-queue'
import { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'
import {
  scheduleWriteback,
  flushPendingWritebacks,
  recordNetworkUpdate,
  resetWritebackState
} from './crdt-writeback'
import { openCrdtPersistence, type CrdtPersistence } from './crdt-persistence'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment, repairEmptyBlockIds } from './blocknote-converter'
import { compactYDoc } from './crdt-compact-utils'
import { isBinaryFileType } from '@memry/shared/file-types'
import { CRITIC_MARKUP_MARKS_ARRAY } from '@memry/shared'

const log = createLogger('CrdtProvider')

interface IpcOrigin {
  source: 'ipc'
  windowId: number
}

const ORIGIN_NETWORK = 'network'
export const ORIGIN_LOCAL = 'local'
const SIZE_CHECK_INTERVAL_MS = 60_000
const ENCODED_SIZE_COMPACTION_THRESHOLD = 1024 * 1024
const ACCUMULATED_BYTES_RECHECK_THRESHOLD = 512 * 1024
const DEFAULT_INACTIVE_DOC_LIMIT = 32

export type SnapshotPushFn = (noteId: string, state: Uint8Array) => Promise<void>

export interface CrdtProviderOptions {
  inactiveDocLimit?: number
  now?: () => number
}

export interface CrdtDocSizeMetric {
  noteId: string
  encodedSizeBytes: number
  accumulatedBytes: number
  pendingSnapshotBytes: number
  windowCount: number
  lastTouchedAt: number
}

export interface CrdtOpenDocMetrics {
  count: number
  totalEncodedSizeBytes: number
  totalAccumulatedBytes: number
  docs: CrdtDocSizeMetric[]
}

interface ActiveDoc {
  doc: Y.Doc
  windowIds: Set<number>
  accumulatedBytes: number
  pendingSnapshotBytes: number
  lastEncodedSize: number
  lastSizeCheckAt: number
  lastTouchedAt: number
  closing?: boolean
}

export class CrdtProvider {
  private docs = new Map<string, ActiveDoc>()
  private openLocks = new Map<string, Promise<Y.Doc>>()
  private persistence: CrdtPersistence | null = null
  private persistenceReady = false
  private persistenceInitPromise: Promise<void> | null = null
  private updateQueue: CrdtUpdateQueue | null = null
  private snapshotPushFn: SnapshotPushFn | null = null
  private readonly inactiveDocLimit: number
  private readonly now: () => number
  private compactingDocs = new Set<string>()
  private compactionBuffers = new Map<string, Uint8Array[]>()
  private networkBatcher = new MicrotaskBatchBroadcaster((noteId, merged) => {
    this.broadcastToWindows(noteId, merged, ORIGIN_NETWORK, undefined)
  })

  constructor(options: CrdtProviderOptions = {}) {
    this.inactiveDocLimit = Math.max(1, options.inactiveDocLimit ?? DEFAULT_INACTIVE_DOC_LIMIT)
    this.now = options.now ?? Date.now
  }

  async init(queue?: CrdtUpdateQueue, snapshotPush?: SnapshotPushFn): Promise<void> {
    await this.initPersistence()

    this.updateQueue = queue ?? null
    this.snapshotPushFn = snapshotPush ?? null
    log.debug('CrdtProvider sync callbacks updated')
  }

  async initPersistence(): Promise<void> {
    // Never retry a settled init: a failed probe means the native binding is
    // broken for this process — re-probing would just re-pay the timeout.
    if (this.persistenceReady) {
      return
    }

    if (!this.persistenceInitPromise) {
      this.persistenceInitPromise = this.doInitPersistence().finally(() => {
        this.persistenceInitPromise = null
      })
    }
    return this.persistenceInitPromise
  }

  private async doInitPersistence(): Promise<void> {
    const storagePath = path.join(app.getPath('userData'), 'crdt-store')
    // Preflight, quarantine and probe live in crdt-persistence.ts; null means
    // the store could not be trusted and this provider runs in-memory.
    this.persistence = await openCrdtPersistence(storagePath)
    this.persistenceReady = true
  }

  isInitialized(): boolean {
    return this.persistenceReady
  }

  async open(noteId: string, windowId?: number, options?: { skipSeed?: boolean }): Promise<Y.Doc> {
    const existing = this.docs.get(noteId)
    if (existing && !existing.closing) {
      if (windowId) existing.windowIds.add(windowId)
      this.touchDoc(existing)
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, existing.doc)
      }
      await this.evictInactiveDocsIfNeeded()
      return existing.doc
    }

    const pending = this.openLocks.get(noteId)
    if (pending) {
      const doc = await pending
      const entry = this.docs.get(noteId)
      if (entry) {
        if (windowId) entry.windowIds.add(windowId)
        this.touchDoc(entry)
      }
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, doc)
      }
      await this.evictInactiveDocsIfNeeded()
      return doc
    }

    const promise = this.doOpen(noteId, windowId, options)
    this.openLocks.set(noteId, promise)
    try {
      return await promise
    } finally {
      this.openLocks.delete(noteId)
    }
  }

  private async doOpen(
    noteId: string,
    windowId?: number,
    options?: { skipSeed?: boolean }
  ): Promise<Y.Doc> {
    const doc = new Y.Doc({ guid: noteId })
    this.initDocStructure(doc)

    if (this.persistence) {
      try {
        const persisted = await this.persistence.getYDoc(noteId)
        if (persisted) {
          const update = Y.encodeStateAsUpdate(persisted)
          Y.applyUpdate(doc, update)
          persisted.destroy()
          // Heal notes previously persisted with empty block ids, which crash the
          // editor with "Block doesn't have id" on mount.
          let repaired = 0
          doc.transact(() => {
            repaired = repairEmptyBlockIds(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
          }, ORIGIN_LOCAL)
          if (repaired > 0) {
            log.info('Repaired empty block ids in persisted note', { noteId, count: repaired })
            await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
          }
        } else {
          log.warn('CRDT persistence returned empty doc; continuing in-memory', { noteId })
        }
      } catch (err) {
        // A failing store must not block the note from opening — fall through
        // to the markdown seed below so content stays visible.
        log.error('Failed to load persisted CRDT doc; seeding from vault file', {
          noteId,
          error: err
        })
      }
    }

    if (!options?.skipSeed) {
      await this.seedFromMarkdown(noteId, doc)
    }

    const entry: ActiveDoc = {
      doc,
      windowIds: new Set(windowId ? [windowId] : []),
      accumulatedBytes: 0,
      pendingSnapshotBytes: 0,
      lastEncodedSize: 0,
      lastSizeCheckAt: 0,
      lastTouchedAt: this.now()
    }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

    await this.evictInactiveDocsIfNeeded()

    return doc
  }

  async close(noteId: string, windowId?: number): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry || entry.closing) return

    if (windowId) {
      entry.windowIds.delete(windowId)
      if (entry.windowIds.size > 0) return
    }

    entry.closing = true

    this.flushNetworkBroadcast(noteId)

    if (this.snapshotPushFn && entry.pendingSnapshotBytes > 0) {
      const state = Y.encodeStateAsUpdate(entry.doc)
      await this.snapshotPushFn(noteId, state).catch((err) => {
        log.warn('Failed to push snapshot on close', { noteId, error: err })
      })
      entry.pendingSnapshotBytes = 0
    }

    await this.flushDoc(noteId).catch((err) => {
      log.error('Failed to flush doc on close', { noteId, error: err })
    })

    if (this.docs.get(noteId) !== entry) {
      // The note was reopened while the flush above was in flight, so doOpen()
      // put a *different* entry — with its own Y.Doc — in the map. That
      // replacement is what the editor is typing into, so the map entry must
      // stay exactly as it is. Only the superseded doc is retired here, and it
      // is provably unreachable: every routing path (applyIpcUpdate,
      // applyIpcSyncStep2, applyRemoteUpdate, getDoc, getDiff, getStateVector,
      // updateMeta, onDocUpdate, broadcastToWindows) re-reads this.docs by
      // noteId and therefore resolves the replacement; nothing outside the
      // provider retains a Y.Doc across awaits; and entry.doc is assigned only
      // in doOpen and in compactDoc's in-place swap, so one doc belongs to
      // exactly one entry and can never be shared with the replacement.
      // Destroying it detaches its 'update' listener instead of leaving it for
      // GC to notice.
      log.debug('Doc reopened during async close, destroying the superseded doc', { noteId })
      entry.doc.destroy()
      return
    }

    entry.doc.destroy()
    this.docs.delete(noteId)
    log.debug('Doc closed', { noteId })
  }

  async closeIfInactive(noteId: string): Promise<boolean> {
    const entry = this.docs.get(noteId)
    if (!entry || entry.closing || entry.windowIds.size > 0) return false

    await this.close(noteId)
    return !this.docs.has(noteId)
  }

  /**
   * Release every doc reference held by a window that no longer exists.
   *
   * The CLOSE_DOC invoke, sent from the renderer's React cleanup, is the only
   * other path that clears a windowId — and ⌘W, a reload, or a renderer crash
   * tears the process down without running it. BrowserWindow ids are monotonic
   * and never recycled, so the stale id pins the doc for the rest of the
   * session: close() early-returns, eviction skips it (windowIds.size === 0)
   * and compaction bails, leaving the update log to grow unbounded.
   *
   * Call this ONLY for a window that has actually been destroyed. A hidden,
   * minimised or background window is still live and must keep its docs
   * pinned. Docs another live window still holds are left untouched, and the
   * release goes through the same closeIfInactive path the sync engine uses,
   * so the doc is flushed to persistence before it is destroyed.
   */
  async forgetWindow(windowId: number): Promise<void> {
    const orphaned: string[] = []
    for (const [noteId, entry] of this.docs) {
      if (!entry.windowIds.delete(windowId)) continue
      if (entry.windowIds.size === 0) orphaned.push(noteId)
    }

    for (const noteId of orphaned) {
      await this.closeIfInactive(noteId)
    }

    if (orphaned.length > 0) {
      log.debug('Released docs held by a closed window', { windowId, count: orphaned.length })
    }
  }

  async purge(noteId: string): Promise<void> {
    await this.close(noteId)
    await this.persistence?.clearDocument(noteId).catch((err) => {
      log.warn('Failed to clear persisted CRDT doc during purge', { noteId, error: err })
    })
  }

  getDoc(noteId: string): Y.Doc | undefined {
    return this.docs.get(noteId)?.doc
  }

  applyRemoteUpdate(noteId: string, update: Uint8Array): void {
    const entry = this.docs.get(noteId)
    if (!entry) {
      log.warn('Received remote update for unopened doc', { noteId })
      return
    }

    if (entry.closing) {
      log.debug('Ignoring remote update for closing doc', { noteId })
      return
    }

    this.touchDoc(entry)

    log.debug('applyRemoteUpdate', {
      noteId,
      bytes: update.byteLength,
      windows: entry.windowIds.size
    })

    if (this.compactingDocs.has(noteId)) {
      const buf = this.compactionBuffers.get(noteId)
      if (buf) {
        buf.push(update)
        log.debug('Buffered remote update during compaction', {
          noteId,
          updateBytes: update.byteLength
        })
        return
      }
    }

    Y.applyUpdate(entry.doc, update, ORIGIN_NETWORK)
  }

  getStateVector(noteId: string): Uint8Array | null {
    const entry = this.docs.get(noteId)
    if (!entry) return null
    this.touchDoc(entry)
    return Y.encodeStateVector(entry.doc)
  }

  getDiff(noteId: string, remoteStateVector: Uint8Array): Uint8Array | null {
    const entry = this.docs.get(noteId)
    if (!entry) return null
    this.touchDoc(entry)
    return Y.encodeStateAsUpdate(entry.doc, remoteStateVector)
  }

  async destroy(): Promise<void> {
    await flushPendingWritebacks()
    this.networkBatcher.flushAll()

    for (const [noteId] of this.docs) {
      try {
        await this.flushDoc(noteId)
      } catch (err) {
        log.warn('Failed to flush doc during CRDT destroy', { noteId, error: err })
      }
    }
    for (const [, entry] of this.docs) {
      entry.doc.destroy()
    }
    this.docs.clear()

    if (this.persistence) {
      try {
        await this.persistence.destroy()
      } catch (err) {
        log.warn('Failed to close CRDT persistence on destroy', { error: err })
      }
      this.persistence = null
    }
    this.persistenceReady = false

    this.openLocks.clear()
    this.updateQueue = null
    this.snapshotPushFn = null

    // Write-back keeps its own module-level per-note maps, keyed by ids and
    // absolute paths belonging to the vault being torn down here.
    resetWritebackState()

    log.info('CrdtProvider destroyed')
  }

  /**
   * Every doc the provider holds, which is not the same as every doc an editor
   * has open: the LRU keeps up to inactiveDocLimit docs cached after their
   * editors closed. Pass `{ active: true }` for the strict subset that still has
   * a window attached — what a caller wants when it must bound per-doc work to
   * what the user is actually looking at.
   */
  getOpenNoteIds({ active = false } = {}): string[] {
    return [...this.docs].filter(([, doc]) => !active || doc.windowIds.size > 0).map(([id]) => id)
  }

  getDocSizeMetrics(): CrdtDocSizeMetric[] {
    return Array.from(this.docs.entries()).map(([noteId, entry]) =>
      this.measureDocSize(noteId, entry)
    )
  }

  getOpenDocMetrics(): CrdtOpenDocMetrics {
    const docs = this.getDocSizeMetrics()
    return {
      count: docs.length,
      totalEncodedSizeBytes: docs.reduce((total, doc) => total + doc.encodedSizeBytes, 0),
      totalAccumulatedBytes: docs.reduce((total, doc) => total + doc.accumulatedBytes, 0),
      docs
    }
  }

  async wipeStorage(): Promise<void> {
    await this.destroy()
    const storagePath = path.join(app.getPath('userData'), 'crdt-store')
    try {
      rmSync(storagePath, { recursive: true, force: true })
      log.info('CRDT storage wiped', { storagePath })
    } catch (err) {
      log.warn('Failed to wipe CRDT storage', { storagePath, error: err })
    }
  }

  async pushAllSnapshots(): Promise<number> {
    if (!this.snapshotPushFn) {
      log.debug('No snapshotPushFn configured, skipping server push')
      return 0
    }

    let pushed = 0
    for (const [noteId, entry] of this.docs) {
      if (entry.pendingSnapshotBytes <= 0) continue
      try {
        const state = Y.encodeStateAsUpdate(entry.doc)
        await this.snapshotPushFn(noteId, state)
        entry.accumulatedBytes = 0
        entry.pendingSnapshotBytes = 0
        pushed++
        log.info('Pushed server snapshot', { noteId, size: state.byteLength })
      } catch (err) {
        log.warn('Failed to push server snapshot', { noteId, error: err })
      }
    }
    return pushed
  }

  async pushSnapshotForNote(noteId: string): Promise<boolean> {
    if (!this.snapshotPushFn) return false

    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (cached?.fileType && isBinaryFileType(cached.fileType)) {
      log.debug('Skipping CRDT snapshot push for binary note', {
        noteId,
        fileType: cached.fileType
      })
      return false
    }

    const wasOpen = this.docs.has(noteId)
    let entry: ActiveDoc | undefined
    let clearedAccumulated = 0
    let clearedPending = 0
    try {
      const doc = await this.open(noteId)
      entry = this.docs.get(noteId)
      const state = Y.encodeStateAsUpdate(doc)
      if (state.length <= 4) {
        if (!wasOpen) await this.close(noteId)
        return false
      }

      // Reset accumulatedBytes BEFORE push so close() won't fire a duplicate push
      if (entry) {
        clearedAccumulated = entry.accumulatedBytes
        clearedPending = entry.pendingSnapshotBytes
        entry.accumulatedBytes = 0
        entry.pendingSnapshotBytes = 0
      }

      await this.snapshotPushFn(noteId, state)
      log.info('Pushed snapshot for note', { noteId, size: state.byteLength })
      if (!wasOpen) await this.close(noteId)
      return true
    } catch (err) {
      log.warn('pushSnapshotForNote failed', { noteId, error: err })
      // Restore the pre-push counters (additive: updates may have landed
      // mid-push) so pushAllSnapshots and close() still retry this note.
      if (entry) {
        entry.accumulatedBytes += clearedAccumulated
        entry.pendingSnapshotBytes += clearedPending
      }
      if (!wasOpen) await this.close(noteId)
      return false
    }
  }

  private initDocStructure(doc: Y.Doc): void {
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.getMap('meta')
    doc.getArray('tags')
    doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  }

  private async seedFromMarkdown(noteId: string, doc: Y.Doc): Promise<void> {
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    if (fragment.length > 0) return

    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return
    if (cached.fileType && isBinaryFileType(cached.fileType)) return

    const raw = await safeRead(toAbsolutePath(cached.path))
    if (!raw) return

    const parsed = parseNote(raw, cached.path)
    if (!parsed.content?.trim()) return

    // Pass the note's path so embed targets are written relative to it — this
    // fragment is what gets serialized back to the vault file.
    const ok = await markdownToYFragment(parsed.content, fragment, cached.path)
    if (ok && this.persistence) {
      await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc)).catch((err) => {
        log.error('Failed to persist markdown-seeded CRDT doc', { noteId, error: err })
      })
    }
  }

  async seedFromMarkdownPublic(noteId: string): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry) return
    await this.seedFromMarkdown(noteId, entry.doc)
  }

  async initForNote(
    noteId: string,
    meta: { title?: string; date?: string },
    tags?: string[]
  ): Promise<Y.Doc> {
    const doc = await this.open(noteId)

    doc.transact(() => {
      const metaMap = doc.getMap('meta')
      if (meta.title && !metaMap.get('title')) metaMap.set('title', meta.title)
      if (meta.date && !metaMap.get('date')) metaMap.set('date', meta.date)

      if (tags?.length) {
        const tagArray = doc.getArray('tags')
        if (tagArray.length === 0) {
          tagArray.push(tags)
        }
      }
    }, ORIGIN_LOCAL)

    return doc
  }

  updateMeta(noteId: string, meta: { title?: string; date?: string }): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)

    entry.doc.transact(() => {
      const metaMap = entry.doc.getMap('meta')
      if (meta.title !== undefined) metaMap.set('title', meta.title)
      if (meta.date !== undefined) metaMap.set('date', meta.date)
    }, ORIGIN_LOCAL)
  }

  async seedExistingDocs(
    entries: Array<{ id: string; title?: string; date?: string; tags?: string[] }>,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const BATCH_SIZE = 50
    let seeded = 0

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      if (signal?.aborted) {
        log.info('CRDT seed aborted', { seeded, total: entries.length })
        return seeded
      }

      const batch = entries.slice(i, i + BATCH_SIZE)

      for (const entry of batch) {
        if (this.docs.has(entry.id)) continue
        if (this.persistence) {
          try {
            const existing = await this.persistence.getYDoc(entry.id)
            const hasContent = Y.encodeStateAsUpdate(existing).length > 4
            existing.destroy()
            if (hasContent) continue
          } catch (err) {
            log.warn('Failed to read persisted doc during seeding; skipping', {
              noteId: entry.id,
              error: err
            })
            continue
          }
        }

        await this.initForNote(entry.id, { title: entry.title, date: entry.date }, entry.tags)
        await this.close(entry.id)
        seeded++
      }

      onProgress?.(Math.min(i + BATCH_SIZE, entries.length), entries.length)

      if (i + BATCH_SIZE < entries.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    log.info('Seeded existing docs', { seeded, total: entries.length })
    return seeded
  }

  private onDocUpdate(noteId: string, update: Uint8Array, origin: unknown): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    this.touchDoc(entry)
    entry.accumulatedBytes += update.byteLength
    if (origin !== ORIGIN_NETWORK) {
      entry.pendingSnapshotBytes += update.byteLength
    }

    if (isIpcOrigin(origin)) {
      this.broadcastToWindows(noteId, update, 'ipc', origin.windowId)
    } else if (origin === ORIGIN_NETWORK) {
      this.queueNetworkBroadcast(noteId, update)
    } else {
      this.broadcastToWindows(noteId, update, ORIGIN_LOCAL, undefined)
    }

    this.persistUpdate(noteId, update)
    this.maybeCompact(noteId)

    if (origin !== ORIGIN_NETWORK && this.updateQueue) {
      this.updateQueue.enqueue(noteId, update)
    }

    if (origin === ORIGIN_NETWORK) {
      recordNetworkUpdate(noteId)
    }

    if (origin === ORIGIN_NETWORK || isIpcOrigin(origin)) {
      scheduleWriteback(noteId, entry.doc)
    }
  }

  private broadcastToWindows(
    noteId: string,
    update: Uint8Array,
    origin: string,
    sourceWindowId: number | undefined
  ): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (entry.windowIds.size === 0) {
      log.debug('No windows to broadcast CRDT update', { noteId, origin })
      return
    }

    for (const windowId of entry.windowIds) {
      if (windowId === sourceWindowId) continue

      const win = BrowserWindow.fromId(windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CRDT_EVENTS.STATE_CHANGED, {
          noteId,
          update,
          origin
        })
      } else {
        // Backstop for a window whose 'closed' hook never ran (opened the note
        // before the hook was registered, or the provider was replaced by a
        // vault switch): drop the id so it stops pinning the doc. A hidden or
        // minimised window still resolves here, so this only ever sheds ids
        // whose window is genuinely gone. Deliberately does not close the doc —
        // this runs inside the doc's own 'update' handler — it just makes the
        // doc eligible for the normal inactive-doc eviction pass.
        entry.windowIds.delete(windowId)
        log.debug('Dropped CRDT broadcast target for a window that is gone', { noteId, windowId })
      }
    }
  }

  private queueNetworkBroadcast(noteId: string, update: Uint8Array): void {
    this.networkBatcher.enqueue(noteId, update)
  }

  private flushNetworkBroadcast(noteId: string): void {
    this.networkBatcher.flush(noteId)
  }

  private persistUpdate(noteId: string, update: Uint8Array): void {
    if (!this.persistence) return
    this.persistence.storeUpdate(noteId, update).catch((err) => {
      log.error('Failed to persist CRDT update', { noteId, error: err })
    })
  }

  private maybeCompact(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    if (entry.accumulatedBytes < ACCUMULATED_BYTES_RECHECK_THRESHOLD) return
    if (this.compactingDocs.has(noteId)) return

    const now = Date.now()
    if (now - entry.lastSizeCheckAt < SIZE_CHECK_INTERVAL_MS) return

    setImmediate(() => this.checkAndCompact(noteId))
  }

  private checkAndCompact(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    entry.lastSizeCheckAt = Date.now()
    const encoded = Y.encodeStateAsUpdate(entry.doc)
    entry.lastEncodedSize = encoded.byteLength

    if (entry.lastEncodedSize > ENCODED_SIZE_COMPACTION_THRESHOLD && entry.windowIds.size === 0) {
      entry.accumulatedBytes = 0
      this.compactDoc(noteId).catch((err) => {
        log.error('Failed to compact doc', { noteId, error: err })
      })
    } else if (entry.accumulatedBytes > ENCODED_SIZE_COMPACTION_THRESHOLD) {
      entry.accumulatedBytes = 0
      this.flushDoc(noteId).catch((err) => {
        log.error('Failed to flush doc', { noteId, error: err })
      })
    }
  }

  private async flushDoc(noteId: string): Promise<void> {
    if (!this.persistence) return
    await this.persistence.flushDocument(noteId)
  }

  private touchDoc(entry: ActiveDoc): void {
    entry.lastTouchedAt = this.now()
  }

  private measureDocSize(noteId: string, entry: ActiveDoc): CrdtDocSizeMetric {
    const encodedSizeBytes = Y.encodeStateAsUpdate(entry.doc).byteLength
    entry.lastEncodedSize = encodedSizeBytes
    return {
      noteId,
      encodedSizeBytes,
      accumulatedBytes: entry.accumulatedBytes,
      pendingSnapshotBytes: entry.pendingSnapshotBytes,
      windowCount: entry.windowIds.size,
      lastTouchedAt: entry.lastTouchedAt
    }
  }

  private async evictInactiveDocsIfNeeded(): Promise<void> {
    const inactiveDocs = Array.from(this.docs.entries()).filter(
      ([, entry]) => entry.windowIds.size === 0 && !entry.closing
    )
    const overflow = inactiveDocs.length - this.inactiveDocLimit
    if (overflow <= 0) return

    inactiveDocs.sort(([, left], [, right]) => left.lastTouchedAt - right.lastTouchedAt)

    for (const [noteId] of inactiveDocs.slice(0, overflow)) {
      await this.closeIfInactive(noteId)
    }
  }

  async compactDoc(noteId: string): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (entry.closing) {
      log.debug('Skipping compaction: doc is closing', { noteId })
      return
    }

    if (entry.windowIds.size > 0) {
      log.debug('Skipping compaction: editors open', { noteId, windowCount: entry.windowIds.size })
      return
    }

    if (this.compactingDocs.has(noteId)) return

    const result = compactYDoc(entry.doc, CRDT_FRAGMENT_NAME)
    if (!result) return

    const beforeSize = entry.lastEncodedSize
    log.info('Compacting doc', {
      noteId,
      beforeSize,
      afterSize: result.compacted.byteLength,
      savedBytes: result.savedBytes
    })

    this.compactingDocs.add(noteId)
    this.compactionBuffers.set(noteId, [])

    try {
      if (this.snapshotPushFn && entry.pendingSnapshotBytes > 0) {
        // Credit only the bytes this payload actually covers. result.compacted
        // was encoded before the await, and applyIpcUpdate writes straight to
        // entry.doc with no compaction guard (only remote updates are
        // buffered), so a local edit landing during the push is genuinely
        // unpushed. Zeroing wiped it, and every path that re-pushes a note —
        // close() and pushAllSnapshots — is gated on this counter, so the note
        // read as pushed and stayed unpushed until a later edit re-armed it.
        // Clamped: close() may have zeroed the counter mid-push.
        const pushedBytes = entry.pendingSnapshotBytes
        await this.snapshotPushFn(noteId, result.compacted)
        entry.pendingSnapshotBytes = Math.max(0, entry.pendingSnapshotBytes - pushedBytes)
      }

      if (this.persistence) {
        await this.persistence.storeUpdate(noteId, result.compacted)
        await this.persistence.flushDocument(noteId)
      }

      // close() only flips `entry.closing` and then deletes (or lets doOpen
      // replace) the map entry — it never consults compaction state, so the
      // entry captured above can be retired, and the note reopened onto a
      // fresh entry, while the pushes above are in flight. Comparing entry
      // identity is what catches that: swapping `entry.doc` on a detached
      // entry would drop the compaction into an object nothing reads, and
      // strand the remote updates buffered for it.
      const live = this.docs.get(noteId)
      if (live !== entry || live?.closing || entry.windowIds.size > 0) {
        log.info('Compaction abandoned: the doc was reopened, closed or replaced mid-compaction', {
          noteId,
          replaced: live !== entry,
          closing: live?.closing === true,
          windowCount: entry.windowIds.size
        })
        this.drainCompactionBuffer(noteId, live)
        return
      }

      const oldDoc = entry.doc
      const newDoc = new Y.Doc()
      // Seeded before the handler is attached on purpose: result.compacted was
      // already pushed and persisted above, so routing it through onDocUpdate
      // would store and broadcast the whole snapshot a second time.
      Y.applyUpdate(newDoc, result.compacted)

      newDoc.on('update', (update: Uint8Array, origin: unknown) => {
        this.onDocUpdate(noteId, update, origin)
      })

      entry.doc = newDoc
      entry.accumulatedBytes = 0
      entry.lastEncodedSize = result.compacted.byteLength
      entry.lastSizeCheckAt = Date.now()

      oldDoc.destroy()

      // Replay the buffer only after the swap, so the updates land on the doc
      // this.docs points at and go through the handler. onDocUpdate is the
      // single funnel for persistUpdate, queueNetworkBroadcast and
      // scheduleWriteback; replaying ahead of it left the compaction window's
      // remote updates in memory only — dropped from the CRDT store, from the
      // vault markdown file and from the broadcast — on every successful
      // compaction that buffered at least one update. Still inside the try, so
      // compactingDocs holds noteId and onDocUpdate's maybeCompact cannot
      // re-enter.
      this.drainCompactionBuffer(noteId, entry)

      log.info('Doc compacted', { noteId, beforeSize, afterSize: result.compacted.byteLength })
    } finally {
      this.compactingDocs.delete(noteId)
      this.compactionBuffers.delete(noteId)
    }
  }

  /**
   * Hand the updates buffered for a finished compaction to whatever doc is live
   * now — the compacted replacement on the happy path, or the doc that took its
   * place when the compaction was abandoned. applyRemoteUpdate diverts remote
   * updates into this buffer for the whole compaction window and reports
   * nothing back to the sync coordinator, which has already recorded those
   * sequence numbers as applied — so a buffer that is discarded, or replayed
   * into a doc with no 'update' handler, is a silently lost remote update, not
   * a retried one.
   *
   * Always call this with the entry `this.docs` currently holds: applying to a
   * detached entry would resurrect the update into a doc nothing reads.
   */
  private drainCompactionBuffer(noteId: string, target: ActiveDoc | undefined): void {
    const buffered = this.compactionBuffers.get(noteId)
    this.compactionBuffers.delete(noteId)
    if (!buffered?.length || !target || target.doc.isDestroyed) return

    for (const update of buffered) {
      Y.applyUpdate(target.doc, update, ORIGIN_NETWORK)
    }
    log.debug('Replayed remote updates buffered for an abandoned compaction', {
      noteId,
      count: buffered.length
    })
  }

  /**
   * Validate that a note exists and is eligible for CRDT (non-binary).
   * Routed through the provider so IPC handlers stay decoupled from the
   * database query layer (architecture boundary).
   */
  validateNoteForCrdt(noteId: string): { ok: true } | { ok: false; error: string } {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return { ok: false, error: `Note not found: ${noteId}` }
    if (cached.fileType && isBinaryFileType(cached.fileType)) {
      return { ok: false, error: `Binary notes do not use CRDT: ${noteId}` }
    }
    return { ok: true }
  }

  applyIpcUpdate(noteId: string, update: Uint8Array, sourceWindowId: number): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)

    const origin: IpcOrigin = { source: 'ipc', windowId: sourceWindowId }
    Y.applyUpdate(entry.doc, update, origin)
  }

  applyIpcSyncStep2(noteId: string, diff: Uint8Array): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)
    Y.applyUpdate(entry.doc, diff, { source: 'ipc', windowId: -1 } satisfies IpcOrigin)
  }
}

function isIpcOrigin(origin: unknown): origin is IpcOrigin {
  return (
    typeof origin === 'object' &&
    origin !== null &&
    'source' in origin &&
    (origin as IpcOrigin).source === 'ipc'
  )
}

let instance: CrdtProvider | null = null

export function getCrdtProvider(): CrdtProvider {
  if (!instance) {
    instance = new CrdtProvider()
  }
  return instance
}

export function resetCrdtProvider(): void {
  instance = null
}
