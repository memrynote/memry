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
} from '@shared/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import { createValidatedHandler } from '../ipc/validate'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById } from '@shared/db/queries/notes'
import type { CrdtUpdateQueue } from './crdt-queue'
import { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'
import { scheduleWriteback, cancelPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment } from './blocknote-converter'

const log = createLogger('CrdtProvider')

interface IpcOrigin {
  source: 'ipc'
  windowId: number
}

const ORIGIN_NETWORK = 'network'
export const ORIGIN_LOCAL = 'local'
const COMPACTION_THRESHOLD_BYTES = 1024 * 1024

export type SnapshotPushFn = (noteId: string, state: Uint8Array) => Promise<void>

interface ActiveDoc {
  doc: Y.Doc
  windowIds: Set<number>
  accumulatedBytes: number
}

export class CrdtProvider {
  private docs = new Map<string, ActiveDoc>()
  private persistence: LeveldbPersistence | null = null
  private updateQueue: CrdtUpdateQueue | null = null
  private snapshotPushFn: SnapshotPushFn | null = null
  private ipcHandlersRegistered = false
  private networkBatcher = new MicrotaskBatchBroadcaster((noteId, merged) => {
    this.broadcastToWindows(noteId, merged, ORIGIN_NETWORK, undefined)
  })

  async init(queue?: CrdtUpdateQueue, snapshotPush?: SnapshotPushFn): Promise<void> {
    // If already initialized in this process, keep the existing persistence handle.
    // Re-registering handlers or re-opening the same LevelDB path can lead to runtime errors.
    if (this.persistence && this.ipcHandlersRegistered) {
      this.updateQueue = queue ?? null
      this.snapshotPushFn = snapshotPush ?? null
      log.debug('CrdtProvider already initialized; callbacks updated')
      return
    }

    this.updateQueue = queue ?? null
    this.snapshotPushFn = snapshotPush ?? null

    // Defensive cleanup for partial init/destroy races.
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
    log.info('CrdtProvider initialized', { storagePath })
  }

  async open(noteId: string, windowId?: number): Promise<Y.Doc> {
    const existing = this.docs.get(noteId)
    if (existing) {
      if (windowId) existing.windowIds.add(windowId)
      return existing.doc
    }

    const doc = new Y.Doc({ guid: noteId })
    this.initDocStructure(doc)

    if (this.persistence) {
      const persisted = await this.persistence.getYDoc(noteId)
      if (persisted) {
        const update = Y.encodeStateAsUpdate(persisted)
        Y.applyUpdate(doc, update)
        persisted.destroy()
      } else {
        // y-leveldb swallows transaction errors and returns null.
        // Continue with an empty in-memory doc so editor remains usable.
        log.warn('CRDT persistence returned empty doc; continuing in-memory', { noteId })
      }
    }

    await this.seedFromMarkdown(noteId, doc)

    const entry: ActiveDoc = {
      doc,
      windowIds: new Set(windowId ? [windowId] : []),
      accumulatedBytes: 0
    }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

    return doc
  }

  close(noteId: string, windowId?: number): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (windowId) {
      entry.windowIds.delete(windowId)
      if (entry.windowIds.size > 0) return
    }

    this.flushNetworkBroadcast(noteId)

    if (this.snapshotPushFn && entry.accumulatedBytes > 0) {
      const state = Y.encodeStateAsUpdate(entry.doc)
      this.snapshotPushFn(noteId, state).catch((err) => {
        log.warn('Failed to push snapshot on close', { noteId, error: err })
      })
    }

    this.flushDoc(noteId).catch((err) => {
      log.error('Failed to flush doc on close', { noteId, error: err })
    })

    entry.doc.destroy()
    this.docs.delete(noteId)
    log.debug('Doc closed', { noteId })
  }

  async purge(noteId: string): Promise<void> {
    this.close(noteId)
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

    this.updateQueue = null
    this.snapshotPushFn = null

    log.info('CrdtProvider destroyed')
  }

  getOpenNoteIds(): string[] {
    return Array.from(this.docs.keys())
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
      try {
        const state = Y.encodeStateAsUpdate(entry.doc)
        await this.snapshotPushFn(noteId, state)
        entry.accumulatedBytes = 0
        pushed++
        log.info('Pushed server snapshot', { noteId, size: state.byteLength })
      } catch (err) {
        log.warn('Failed to push server snapshot', { noteId, error: err })
      }
    }
    return pushed
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

    const raw = await safeRead(toAbsolutePath(cached.path))
    if (!raw) return

    const parsed = parseNote(raw, cached.path)
    if (!parsed.content?.trim()) return

    const ok = await markdownToYFragment(parsed.content, fragment)
    if (ok && this.persistence) {
      await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
    }
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

    for (const windowId of entry.windowIds) {
      if (windowId === sourceWindowId) continue

      const win = BrowserWindow.fromId(windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CRDT_EVENTS.STATE_CHANGED, {
          noteId,
          update: Array.from(update),
          origin
        })
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

    if (entry.accumulatedBytes > COMPACTION_THRESHOLD_BYTES) {
      entry.accumulatedBytes = 0
      this.flushDoc(noteId).catch((err) => {
        log.error('Failed to compact doc', { noteId, error: err })
      })
    }
  }

  private async flushDoc(noteId: string): Promise<void> {
    if (!this.persistence) return
    await this.persistence.flushDocument(noteId)
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

      await this.open(noteId, windowId)
      return { success: true }
    })

    ipcMain.handle(CRDT_CHANNELS.CLOSE_DOC, async (event, rawInput: unknown) => {
      const { noteId } = CrdtCloseDocSchema.parse(rawInput)
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id
      this.close(noteId, windowId)
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
