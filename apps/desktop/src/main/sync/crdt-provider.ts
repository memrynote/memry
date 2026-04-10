import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  CRDT_CHANNELS,
  CRDT_EVENTS,
  CRDT_FRAGMENT_NAME,
  CrdtApplyUpdateSchema,
  CrdtCloseDocSchema,
  CrdtOpenDocSchema,
  CrdtSyncStep1Schema,
  CrdtSyncStep2Schema,
  type CrdtSyncStep1Result
} from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import { createValidatedHandler } from '../ipc/validate'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById } from '@main/database/queries/notes'
import type { CrdtUpdateQueue } from './crdt-queue'
import { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'
import { scheduleWriteback, cancelPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment } from './blocknote-converter'
import { compactYDoc } from './crdt-compact-utils'
import { isBinaryFileType } from '@memry/shared/file-types'

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

export type SnapshotPushFn = (noteId: string, state: Uint8Array) => Promise<void>

interface ActiveDoc {
  doc: Y.Doc
  windowIds: Set<number>
  accumulatedBytes: number
  pendingSnapshotBytes: number
  lastEncodedSize: number
  lastSizeCheckAt: number
  closing?: boolean
}

export class CrdtProvider {
  private docs = new Map<string, ActiveDoc>()
  private openLocks = new Map<string, Promise<Y.Doc>>()
  private persistence: LeveldbPersistence | null = null
  private updateQueue: CrdtUpdateQueue | null = null
  private snapshotPushFn: SnapshotPushFn | null = null
  private ipcHandlersRegistered = false
  private compactingDocs = new Set<string>()
  private compactionBuffers = new Map<string, Uint8Array[]>()
  private networkBatcher = new MicrotaskBatchBroadcaster((noteId, merged) => {
    this.broadcastToWindows(noteId, merged, ORIGIN_NETWORK, undefined)
  })

  async init(queue?: CrdtUpdateQueue, snapshotPush?: SnapshotPushFn): Promise<void> {
    await this.initPersistence()

    this.updateQueue = queue ?? null
    this.snapshotPushFn = snapshotPush ?? null
    log.debug('CrdtProvider sync callbacks updated')
  }

  async initPersistence(): Promise<void> {
    if (this.persistence && this.ipcHandlersRegistered) {
      return
    }

    if (this.persistence) {
      try {
        await this.persistence.destroy()
      } catch (err) {
        log.warn('Failed to close stale CRDT persistence before init', { error: err })
      }
      this.persistence = null
    }

    const storagePath = path.join(app.getPath('userData'), 'crdt-store')
    this.persistence = new LeveldbPersistence(storagePath)
    if (!this.ipcHandlersRegistered) {
      this.registerIpcHandlers()
      this.ipcHandlersRegistered = true
    }
    log.info('CrdtProvider persistence initialized', { storagePath })
  }

  async open(noteId: string, windowId?: number, options?: { skipSeed?: boolean }): Promise<Y.Doc> {
    const existing = this.docs.get(noteId)
    if (existing && !existing.closing) {
      if (windowId) existing.windowIds.add(windowId)
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, existing.doc)
      }
      return existing.doc
    }

    const pending = this.openLocks.get(noteId)
    if (pending) {
      const doc = await pending
      const entry = this.docs.get(noteId)
      if (entry && windowId) entry.windowIds.add(windowId)
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, doc)
      }
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
      const persisted = await this.persistence.getYDoc(noteId)
      if (persisted) {
        const update = Y.encodeStateAsUpdate(persisted)
        Y.applyUpdate(doc, update)
        persisted.destroy()
      } else {
        log.warn('CRDT persistence returned empty doc; continuing in-memory', { noteId })
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
      lastSizeCheckAt: 0
    }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

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
      log.debug('Doc reopened during async close, skipping destroy', { noteId })
      return
    }

    entry.doc.destroy()
    this.docs.delete(noteId)
    log.debug('Doc closed', { noteId })
  }

  async purge(noteId: string): Promise<void> {
    await this.close(noteId)
    await this.persistence?.clearDocument(noteId)
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
    return Y.encodeStateVector(entry.doc)
  }

  getDiff(noteId: string, remoteStateVector: Uint8Array): Uint8Array | null {
    const entry = this.docs.get(noteId)
    if (!entry) return null
    return Y.encodeStateAsUpdate(entry.doc, remoteStateVector)
  }

  async destroy(): Promise<void> {
    cancelPendingWritebacks()
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

    if (this.ipcHandlersRegistered) {
      ipcMain.removeHandler(CRDT_CHANNELS.OPEN_DOC)
      ipcMain.removeHandler(CRDT_CHANNELS.CLOSE_DOC)
      ipcMain.removeHandler(CRDT_CHANNELS.APPLY_UPDATE)
      ipcMain.removeHandler(CRDT_CHANNELS.SYNC_STEP_1)
      ipcMain.removeHandler(CRDT_CHANNELS.SYNC_STEP_2)
      this.ipcHandlersRegistered = false
    }

    if (this.persistence) {
      try {
        await this.persistence.destroy()
      } catch (err) {
        log.warn('Failed to close CRDT persistence on destroy', { error: err })
      }
      this.persistence = null
    }

    this.openLocks.clear()
    this.updateQueue = null
    this.snapshotPushFn = null

    log.info('CrdtProvider destroyed')
  }

  getOpenNoteIds(): string[] {
    return Array.from(this.docs.keys())
  }

  getDocSizeMetrics(): Array<{
    noteId: string
    encodedSizeBytes: number
    accumulatedBytes: number
    windowCount: number
  }> {
    return Array.from(this.docs.entries()).map(([noteId, entry]) => ({
      noteId,
      encodedSizeBytes: entry.lastEncodedSize,
      accumulatedBytes: entry.accumulatedBytes,
      windowCount: entry.windowIds.size
    }))
  }

  async wipeStorage(): Promise<void> {
    await this.destroy()
    const storagePath = path.join(app.getPath('userData'), 'crdt-store')
    try {
      const { rmSync } = await import('fs')
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
    try {
      const doc = await this.open(noteId)
      const entry = this.docs.get(noteId)
      const state = Y.encodeStateAsUpdate(doc)
      if (state.length <= 4) {
        if (!wasOpen) await this.close(noteId)
        return false
      }

      // Reset accumulatedBytes BEFORE push so close() won't fire a duplicate push
      if (entry) {
        entry.accumulatedBytes = 0
        entry.pendingSnapshotBytes = 0
      }

      await this.snapshotPushFn(noteId, state)
      log.info('Pushed snapshot for note', { noteId, size: state.byteLength })
      if (!wasOpen) await this.close(noteId)
      return true
    } catch (err) {
      log.warn('pushSnapshotForNote failed', { noteId, error: err })
      if (!wasOpen) await this.close(noteId)
      return false
    }
  }

  private initDocStructure(doc: Y.Doc): void {
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.getMap('meta')
    doc.getArray('tags')
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

    const ok = await markdownToYFragment(parsed.content, fragment)
    if (ok && this.persistence) {
      await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
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
          const existing = await this.persistence.getYDoc(entry.id)
          const hasContent = Y.encodeStateAsUpdate(existing).length > 4
          existing.destroy()
          if (hasContent) continue
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
          update: Array.from(update),
          origin
        })
      } else {
        log.debug('Skipping CRDT broadcast for unavailable window', { noteId, windowId })
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

  async compactDoc(noteId: string): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry) return

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
        await this.snapshotPushFn(noteId, result.compacted)
        entry.pendingSnapshotBytes = 0
      }

      if (this.persistence) {
        await this.persistence.storeUpdate(noteId, result.compacted)
        await this.persistence.flushDocument(noteId)
      }

      if (entry.windowIds.size > 0) {
        log.info('Compaction aborted: editor opened during compaction', { noteId })
        return
      }

      const oldDoc = entry.doc
      const newDoc = new Y.Doc()
      Y.applyUpdate(newDoc, result.compacted)

      const buffered = this.compactionBuffers.get(noteId) ?? []
      for (const update of buffered) {
        Y.applyUpdate(newDoc, update, ORIGIN_NETWORK)
      }

      newDoc.on('update', (update: Uint8Array, origin: unknown) => {
        this.onDocUpdate(noteId, update, origin)
      })

      entry.doc = newDoc
      entry.accumulatedBytes = 0
      entry.lastEncodedSize = result.compacted.byteLength
      entry.lastSizeCheckAt = Date.now()

      oldDoc.destroy()

      log.info('Doc compacted', { noteId, beforeSize, afterSize: result.compacted.byteLength })
    } finally {
      this.compactingDocs.delete(noteId)
      this.compactionBuffers.delete(noteId)
    }
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(CRDT_CHANNELS.OPEN_DOC, async (event, rawInput: unknown) => {
      const { noteId } = CrdtOpenDocSchema.parse(rawInput)
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id

      const indexDb = getIndexDatabase()
      const noteExists = getNoteCacheById(indexDb, noteId)
      if (!noteExists) {
        return { success: false, error: `Note not found: ${noteId}` }
      }
      if (noteExists.fileType && isBinaryFileType(noteExists.fileType)) {
        return { success: false, error: `Binary notes do not use CRDT: ${noteId}` }
      }

      await this.open(noteId, windowId)
      return { success: true }
    })

    ipcMain.handle(CRDT_CHANNELS.CLOSE_DOC, async (event, rawInput: unknown) => {
      const { noteId } = CrdtCloseDocSchema.parse(rawInput)
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id
      await this.close(noteId, windowId)
      return { success: true }
    })

    ipcMain.handle(CRDT_CHANNELS.APPLY_UPDATE, async (event, rawInput: unknown) => {
      const { noteId, update: updateArr } = CrdtApplyUpdateSchema.parse(rawInput)
      const sourceWindowId = BrowserWindow.fromWebContents(event.sender)?.id ?? -1

      const entry = this.docs.get(noteId)
      if (!entry) return

      const update = new Uint8Array(updateArr)
      const origin: IpcOrigin = { source: 'ipc', windowId: sourceWindowId }
      Y.applyUpdate(entry.doc, update, origin)
    })

    ipcMain.handle(
      CRDT_CHANNELS.SYNC_STEP_1,
      createValidatedHandler(
        CrdtSyncStep1Schema,
        async (input): Promise<CrdtSyncStep1Result | null> => {
          const doc = await this.open(input.noteId)
          const remoteVector = new Uint8Array(input.stateVector)
          const diff = Y.encodeStateAsUpdate(doc, remoteVector)
          const stateVector = Y.encodeStateVector(doc)
          return { diff, stateVector }
        }
      )
    )

    ipcMain.handle(
      CRDT_CHANNELS.SYNC_STEP_2,
      createValidatedHandler(CrdtSyncStep2Schema, async (input) => {
        const entry = this.docs.get(input.noteId)
        if (!entry) return
        const diff = new Uint8Array(input.diff)
        Y.applyUpdate(entry.doc, diff, { source: 'ipc', windowId: -1 } satisfies IpcOrigin)
      })
    )
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
