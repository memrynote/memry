import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  CRDT_CHANNELS,
  CRDT_EVENTS,
  type CrdtApplyUpdateInput,
  type CrdtSyncStep1Input,
  type CrdtSyncStep1Result,
  type CrdtSyncStep2Input
} from '@shared/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import type { CrdtUpdateQueue } from './crdt-queue'
import { scheduleWriteback, cancelPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'

const log = createLogger('CrdtProvider')

const ORIGIN_IPC = 'ipc'
const ORIGIN_NETWORK = 'network'
export const ORIGIN_LOCAL = 'local'
const COMPACTION_THRESHOLD_BYTES = 1024 * 1024

interface ActiveDoc {
  doc: Y.Doc
  windowIds: Set<number>
}

export class CrdtProvider {
  private docs = new Map<string, ActiveDoc>()
  private persistence: LeveldbPersistence | null = null
  private updateQueue: CrdtUpdateQueue | null = null

  async init(queue?: CrdtUpdateQueue): Promise<void> {
    this.updateQueue = queue ?? null
    const storagePath = path.join(app.getPath('userData'), 'crdt-store')
    this.persistence = new LeveldbPersistence(storagePath)
    this.registerIpcHandlers()
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
      const update = Y.encodeStateAsUpdate(persisted)
      Y.applyUpdate(doc, update)
      persisted.destroy()
    }

    const entry: ActiveDoc = { doc, windowIds: new Set(windowId ? [windowId] : []) }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

    log.debug('Doc opened', { noteId, windowId })
    return doc
  }

  close(noteId: string, windowId?: number): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (windowId) {
      entry.windowIds.delete(windowId)
      if (entry.windowIds.size > 0) return
    }

    this.flushDoc(noteId).catch((err) => {
      log.error('Failed to flush doc on close', { noteId, error: err })
    })

    entry.doc.destroy()
    this.docs.delete(noteId)
    log.debug('Doc closed', { noteId })
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
    for (const [noteId] of this.docs) {
      await this.flushDoc(noteId)
    }
    for (const [, entry] of this.docs) {
      entry.doc.destroy()
    }
    this.docs.clear()
    log.info('CrdtProvider destroyed')
  }

  private initDocStructure(doc: Y.Doc): void {
    doc.getXmlFragment('prosemirror')
    doc.getMap('meta')
    doc.getArray('tags')
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

  async seedExistingDocs(
    entries: Array<{ id: string; title?: string; date?: string; tags?: string[] }>,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    const BATCH_SIZE = 50
    let seeded = 0

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE)

      for (const entry of batch) {
        if (this.docs.has(entry.id)) continue
        if (this.persistence) {
          const existing = await this.persistence.getYDoc(entry.id)
          const hasContent = Y.encodeStateAsUpdate(existing).length > 4
          existing.destroy()
          if (hasContent) continue
        }

        await this.initForNote(
          entry.id,
          { title: entry.title, date: entry.date },
          entry.tags
        )
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

    if (origin === ORIGIN_IPC || origin === ORIGIN_NETWORK) {
      this.broadcastToWindows(noteId, update, origin as string, undefined)
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

  private persistUpdate(noteId: string, update: Uint8Array): void {
    if (!this.persistence) return
    this.persistence.storeUpdate(noteId, update).catch((err) => {
      log.error('Failed to persist CRDT update', { noteId, error: err })
    })
  }

  private maybeCompact(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    const size = Y.encodeStateAsUpdate(entry.doc).byteLength
    if (size > COMPACTION_THRESHOLD_BYTES) {
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
    ipcMain.handle(CRDT_CHANNELS.OPEN_DOC, async (_event, input: { noteId: string }) => {
      const windowId = BrowserWindow.fromWebContents(_event.sender)?.id
      await this.open(input.noteId, windowId)
      return { success: true }
    })

    ipcMain.handle(CRDT_CHANNELS.CLOSE_DOC, async (_event, input: { noteId: string }) => {
      const windowId = BrowserWindow.fromWebContents(_event.sender)?.id
      this.close(input.noteId, windowId)
      return { success: true }
    })

    ipcMain.handle(
      CRDT_CHANNELS.APPLY_UPDATE,
      async (_event, input: CrdtApplyUpdateInput) => {
        const entry = this.docs.get(input.noteId)
        if (!entry) return

        const update = new Uint8Array(input.update)
        Y.applyUpdate(entry.doc, update, ORIGIN_IPC)
        this.broadcastToWindows(input.noteId, update, ORIGIN_IPC, input.sourceWindowId)
      }
    )

    ipcMain.handle(
      CRDT_CHANNELS.SYNC_STEP_1,
      async (_event, input: CrdtSyncStep1Input): Promise<CrdtSyncStep1Result | null> => {
        const doc = await this.open(input.noteId)
        const remoteVector = new Uint8Array(input.stateVector)
        const diff = Y.encodeStateAsUpdate(doc, remoteVector)
        const stateVector = Y.encodeStateVector(doc)
        return { diff, stateVector }
      }
    )

    ipcMain.handle(
      CRDT_CHANNELS.SYNC_STEP_2,
      async (_event, input: CrdtSyncStep2Input) => {
        const entry = this.docs.get(input.noteId)
        if (!entry) return
        const diff = new Uint8Array(input.diff)
        Y.applyUpdate(entry.doc, diff, ORIGIN_IPC)
      }
    )
  }
}

let instance: CrdtProvider | null = null

export function getCrdtProvider(): CrdtProvider {
  if (!instance) {
    instance = new CrdtProvider()
  }
  return instance
}
