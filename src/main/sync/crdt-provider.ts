/**
 * CRDT Provider for Yjs Document Synchronization
 *
 * Manages Y.Doc instances per note in the main process.
 * Handles persistence via y-leveldb and coordinates with SyncEngine for encryption.
 *
 * T129: Create Main-Process Yjs Host
 * T130: Yjs Document Creation Per Note
 * T131: State Vector Tracking
 * T132: Incremental Update Encryption
 * T133: Snapshot Compaction
 * T134: y-leveldb Integration
 *
 * @module sync/crdt-provider
 */

import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { app, BrowserWindow } from 'electron'
import path from 'path'
import pako from 'pako'

import { SyncChannels } from '@shared/contracts/ipc-sync'
import { uint8ArrayToBase64 } from '@shared/utils/encoding'
import { TypedEmitter } from './typed-emitter'
import type { CrdtSyncBridge } from './crdt-sync-bridge'

const SNAPSHOT_THRESHOLD = 100
const GC_SIZE_THRESHOLD = 1024 * 1024 // 1MB - trigger GC when doc exceeds this
const PAKO_ZLIB_HEADER = 0x78 // zlib default compression header

function compressSnapshot(data: Uint8Array): Uint8Array {
  return pako.deflate(data)
}

function decompressSnapshot(data: Uint8Array): Uint8Array {
  return pako.inflate(data)
}

function isCompressed(data: Uint8Array): boolean {
  return data.length > 0 && data[0] === PAKO_ZLIB_HEADER
}

function maybeDecompress(data: Uint8Array): Uint8Array {
  if (isCompressed(data)) {
    return decompressSnapshot(data)
  }
  return data
}

export interface CrdtProviderEvents extends Record<string, unknown[]> {
  'crdt:doc-updated': [payload: { noteId: string; update: Uint8Array; origin: string }]
  'crdt:doc-synced': [payload: { noteId: string; timestamp: number }]
  'crdt:error': [payload: { noteId: string; error: Error }]
}

interface DocEntry {
  doc: Y.Doc
  updateCount: number
  lastActivity: number
  lastSize: number
}

interface NoteSyncTiming {
  lastRemoteUpdate: number
  lastExternalUpdate: number
}

export class CrdtProvider extends TypedEmitter<CrdtProviderEvents> {
  private static readonly CONFLICT_WINDOW_MS = 5000
  private static readonly MAX_UPDATE_SIZE = 10 * 1024 * 1024 // 10MB limit
  private static readonly MAX_LOADED_DOCS = 500
  private static readonly EVICTION_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes
  private static readonly EVICTION_CHECK_INTERVAL_MS = 60 * 1000 // 1 minute
  private static readonly PROACTIVE_GC_THRESHOLD = 512 * 1024 // 512KB
  private static readonly PROACTIVE_GC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

  private docs: Map<string, DocEntry> = new Map()
  private docCreationLocks: Map<string, Promise<Y.Doc>> = new Map()
  private persistence: LeveldbPersistence | null = null
  private dbPath: string = ''
  private dbReady: Promise<void> | null = null
  private initialized = false
  private shuttingDown = false
  private syncBridge: CrdtSyncBridge | null = null
  private evictionTimer: NodeJS.Timeout | null = null
  private proactiveGcTimer: NodeJS.Timeout | null = null

  // T140k: External change tracking
  private externalChangeTimes: Map<string, number> = new Map()

  // T140n: Sync timing for conflict detection
  private syncTimings: Map<string, NoteSyncTiming> = new Map()

  // Loop prevention: track CRDT-originated file writes
  private recentCrdtWrites: Map<string, number> = new Map()

  async initialize(customDbPath?: string): Promise<void> {
    if (this.initialized) return

    this.dbPath = customDbPath ?? path.join(app.getPath('userData'), 'yjs-store')
    this.persistence = new LeveldbPersistence(this.dbPath)

    this.dbReady = (async () => {
      try {
        const docNames = await this.persistence!.getAllDocNames()
        if (docNames.length > 0) {
          await this.persistence!.getYDoc(docNames[0])
        }
      } catch (error) {
        console.warn('[CrdtProvider] DB warmup failed, will initialize lazily:', error)
      }
    })()
    await this.dbReady

    this.evictionTimer = setInterval(() => {
      void this.evictInactiveDocs()
    }, CrdtProvider.EVICTION_CHECK_INTERVAL_MS)

    this.proactiveGcTimer = setInterval(() => {
      void this.runProactiveGc()
    }, CrdtProvider.PROACTIVE_GC_INTERVAL_MS)

    this.initialized = true
    console.info('[CrdtProvider] Initialized at', this.dbPath)
  }

  setSyncBridge(bridge: CrdtSyncBridge): void {
    this.syncBridge = bridge
  }

  private async waitForDb(): Promise<LeveldbPersistence | null> {
    if (!this.initialized || !this.persistence || this.shuttingDown) return null
    if (this.dbReady) await this.dbReady
    if (this.shuttingDown) return null
    return this.persistence
  }

  async getOrCreateDoc(noteId: string): Promise<Y.Doc> {
    this.ensureInitialized()

    const existing = this.docs.get(noteId)
    if (existing) {
      existing.lastActivity = Date.now()
      return existing.doc
    }

    const pendingCreation = this.docCreationLocks.get(noteId)
    if (pendingCreation) {
      return pendingCreation
    }

    const creationPromise = this.createDoc(noteId)
    this.docCreationLocks.set(noteId, creationPromise)

    try {
      return await creationPromise
    } finally {
      this.docCreationLocks.delete(noteId)
    }
  }

  private async createDoc(noteId: string): Promise<Y.Doc> {
    const doc = new Y.Doc({ guid: noteId })
    let initialSize = 0

    const persistence = await this.waitForDb()
    if (persistence) {
      const storedDoc = await persistence.getYDoc(noteId)
      if (storedDoc) {
        const update = Y.encodeStateAsUpdate(storedDoc)
        Y.applyUpdate(doc, update)
        initialSize = update.length
      } else {
        doc.getXmlFragment('document-store')
        doc.getMap('meta').set('created', Date.now())
      }
    } else {
      doc.getXmlFragment('document-store')
      doc.getMap('meta').set('created', Date.now())
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.handleDocUpdate(noteId, update, origin)
    })

    this.docs.set(noteId, {
      doc,
      updateCount: 0,
      lastActivity: Date.now(),
      lastSize: initialSize
    })

    return doc
  }

  private handleDocUpdate(noteId: string, update: Uint8Array, origin: unknown): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    entry.updateCount++
    entry.lastActivity = Date.now()
    entry.lastSize += update.length

    const shouldPersist = origin !== 'remote' && origin !== 'persistence'
    const shouldEmit = shouldPersist && origin !== 'bootstrap'

    if (shouldPersist) {
      void this.waitForDb().then((persistence) => {
        if (persistence) {
          persistence.storeUpdate(noteId, update).catch((error) => {
            if (!this.shuttingDown) {
              console.error('[CrdtProvider] storeUpdate failed:', noteId, error)
              this.emit('crdt:error', { noteId, error: error as Error })
            }
          })
        }
      })
    }

    if (shouldEmit) {
      this.emit('crdt:doc-updated', {
        noteId,
        update,
        origin: typeof origin === 'string' ? origin : 'local'
      })
    }

    if (shouldPersist) {
      if (this.shouldGarbageCollect(noteId)) {
        void this.garbageCollectDoc(noteId)
      } else if (this.shouldCompact(noteId)) {
        void this.compactDoc(noteId)
      }
    }
  }

  applyUpdate(
    noteId: string,
    update: Uint8Array,
    origin: string = 'remote',
    sourceWindowId?: number
  ): void {
    if (update.length > CrdtProvider.MAX_UPDATE_SIZE) {
      throw new Error(
        `CRDT update exceeds maximum size: ${update.length} bytes (limit: ${CrdtProvider.MAX_UPDATE_SIZE})`
      )
    }

    const entry = this.docs.get(noteId)
    if (!entry) {
      console.warn('[CrdtProvider] Cannot apply update to unknown doc:', noteId)
      return
    }

    Y.applyUpdate(entry.doc, update, origin)

    void this.waitForDb().then((persistence) => {
      if (persistence) {
        persistence.storeUpdate(noteId, update).catch((error) => {
          if (!this.shuttingDown) {
            console.error('[CrdtProvider] storeUpdate failed:', noteId, error)
          }
        })
      }
    })

    this.broadcastToWindows(noteId, update, sourceWindowId)
  }

  private broadcastToWindows(noteId: string, update: Uint8Array, excludeWindowId?: number): void {
    const updateBase64 = uint8ArrayToBase64(update)
    BrowserWindow.getAllWindows()
      .filter((w) => w.id !== excludeWindowId)
      .forEach((w) => {
        w.webContents.send(SyncChannels.events.YJS_UPDATE_RECEIVED, {
          noteId,
          update: updateBase64,
          sourceWindowId: excludeWindowId
        })
      })
  }

  getStateVector(noteId: string): Uint8Array {
    const entry = this.docs.get(noteId)
    if (!entry) {
      throw new Error(`Doc not found: ${noteId}`)
    }
    return Y.encodeStateVector(entry.doc)
  }

  encodeSnapshot(noteId: string, compress: boolean = true): Uint8Array {
    const entry = this.docs.get(noteId)
    if (!entry) {
      throw new Error(`Doc not found: ${noteId}`)
    }
    const rawSnapshot = Y.encodeStateAsUpdate(entry.doc)
    return compress ? compressSnapshot(rawSnapshot) : rawSnapshot
  }

  applySnapshot(noteId: string, data: Uint8Array): void {
    const entry = this.docs.get(noteId)
    if (!entry) {
      console.warn('[CrdtProvider] Cannot apply snapshot to unknown doc:', noteId)
      return
    }

    try {
      const wasCompressed = isCompressed(data)
      const snapshot = maybeDecompress(data)
      Y.applyUpdate(entry.doc, snapshot, 'remote')
      entry.lastSize = snapshot.length

      console.debug('[CrdtProvider] Applied snapshot:', noteId, {
        wasCompressed,
        originalSize: data.length,
        decompressedSize: snapshot.length
      })

      this.broadcastToWindows(noteId, snapshot)
    } catch (error) {
      console.error('[CrdtProvider] Failed to apply snapshot:', noteId, error)
      throw error
    }
  }

  encodeDiff(noteId: string, clientStateVector: Uint8Array): Uint8Array {
    const entry = this.docs.get(noteId)
    if (!entry) {
      throw new Error(`Doc not found: ${noteId}`)
    }
    return Y.encodeStateAsUpdate(entry.doc, clientStateVector)
  }

  private shouldCompact(noteId: string): boolean {
    const entry = this.docs.get(noteId)
    return (entry?.updateCount ?? 0) >= SNAPSHOT_THRESHOLD
  }

  private shouldGarbageCollect(noteId: string): boolean {
    const entry = this.docs.get(noteId)
    if (!entry) return false
    return entry.lastSize > GC_SIZE_THRESHOLD
  }

  private async runProactiveGc(): Promise<void> {
    if (this.shuttingDown) return

    const candidates: string[] = []
    for (const [noteId, entry] of this.docs) {
      if (entry.lastSize > CrdtProvider.PROACTIVE_GC_THRESHOLD) {
        candidates.push(noteId)
      }
    }

    if (candidates.length === 0) return

    console.info(`[CrdtProvider] Proactive GC: ${candidates.length} documents over threshold`)

    for (const noteId of candidates) {
      if (this.shuttingDown) break
      try {
        await this.garbageCollectDoc(noteId)
      } catch (error) {
        console.warn('[CrdtProvider] Proactive GC failed for:', noteId, error)
      }
    }
  }

  async garbageCollectDoc(noteId: string): Promise<void> {
    const persistence = await this.waitForDb()
    if (!persistence) return

    const entry = this.docs.get(noteId)
    if (!entry) return

    try {
      const freshDoc = new Y.Doc({ guid: noteId, gc: true })
      const currentState = Y.encodeStateAsUpdate(entry.doc)
      Y.applyUpdate(freshDoc, currentState, 'gc')

      entry.doc.destroy()
      entry.doc = freshDoc
      entry.updateCount = 0
      entry.lastSize = currentState.length

      freshDoc.on('update', (update: Uint8Array, origin: unknown) => {
        this.handleDocUpdate(noteId, update, origin)
      })

      await persistence.clearDocument(noteId)
      await persistence.storeUpdate(noteId, currentState)

      console.info('[CrdtProvider] GC completed for doc:', noteId, {
        newSize: entry.lastSize
      })

      this.queueSnapshotForSync(noteId)
    } catch (error) {
      if (!this.shuttingDown) {
        console.error('[CrdtProvider] GC failed:', noteId, error)
        this.emit('crdt:error', { noteId, error: error as Error })
      }
    }
  }

  async compactDoc(noteId: string): Promise<void> {
    const persistence = await this.waitForDb()
    if (!persistence) return

    const entry = this.docs.get(noteId)
    if (!entry) return

    try {
      await persistence.flushDocument(noteId)
      entry.updateCount = 0
      console.info('[CrdtProvider] Compacted doc:', noteId)
      this.queueSnapshotForSync(noteId)
    } catch (error) {
      if (!this.shuttingDown) {
        console.error('[CrdtProvider] Compaction failed:', noteId, error)
        this.emit('crdt:error', { noteId, error: error as Error })
      }
    }
  }

  private queueSnapshotForSync(noteId: string): void {
    if (!this.syncBridge) {
      return
    }

    try {
      const compressedSnapshot = this.encodeSnapshot(noteId, true)
      void this.syncBridge.pushSnapshot(noteId, compressedSnapshot)

      console.debug('[CrdtProvider] Snapshot queued for sync:', noteId, {
        compressedSize: compressedSnapshot.length
      })
    } catch (error) {
      console.error('[CrdtProvider] Failed to queue snapshot for sync:', noteId, error)
    }

    this.emit('crdt:doc-synced', { noteId, timestamp: Date.now() })
  }

  destroyDoc(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    entry.doc.destroy()
    this.docs.delete(noteId)

    // Cleanup timing maps to prevent memory leaks
    this.externalChangeTimes.delete(noteId)
    this.syncTimings.delete(noteId)
    this.recentCrdtWrites.delete(noteId)
  }

  private async evictInactiveDocs(): Promise<void> {
    if (this.shuttingDown || this.docs.size <= CrdtProvider.MAX_LOADED_DOCS) {
      return
    }

    const now = Date.now()
    const candidates: Array<[string, number]> = []

    for (const [noteId, entry] of this.docs) {
      if (now - entry.lastActivity > CrdtProvider.EVICTION_THRESHOLD_MS) {
        candidates.push([noteId, entry.lastActivity])
      }
    }

    if (candidates.length === 0) {
      return
    }

    candidates.sort((a, b) => a[1] - b[1])

    const toEvict = Math.min(candidates.length, this.docs.size - CrdtProvider.MAX_LOADED_DOCS)

    console.info(`[CrdtProvider] Evicting ${toEvict} inactive documents`)

    for (let i = 0; i < toEvict; i++) {
      const [noteId] = candidates[i]
      try {
        await this.compactDoc(noteId)
      } catch (error) {
        console.warn('[CrdtProvider] Compact before eviction failed:', noteId, error)
      }
      this.destroyDoc(noteId)
    }
  }

  async clearDoc(noteId: string): Promise<void> {
    this.destroyDoc(noteId)
    const persistence = await this.waitForDb()
    if (persistence) {
      await persistence.clearDocument(noteId)
    }
  }

  getDoc(noteId: string): Y.Doc | undefined {
    return this.docs.get(noteId)?.doc
  }

  hasDoc(noteId: string): boolean {
    return this.docs.has(noteId)
  }

  getLoadedDocIds(): string[] {
    return Array.from(this.docs.keys())
  }

  async getAllDocNames(): Promise<string[]> {
    this.ensureInitialized()
    const persistence = await this.waitForDb()
    if (!persistence) return []
    return persistence.getAllDocNames()
  }

  // =========================================================================
  // T140k: External Change Tracking
  // =========================================================================

  recordExternalChange(noteId: string): void {
    this.externalChangeTimes.set(noteId, Date.now())
  }

  getLastExternalChangeTime(noteId: string): number | undefined {
    return this.externalChangeTimes.get(noteId)
  }

  // =========================================================================
  // T140n: Sync Timing & Conflict Detection
  // =========================================================================

  recordRemoteUpdate(noteId: string): void {
    const existing = this.syncTimings.get(noteId) ?? { lastRemoteUpdate: 0, lastExternalUpdate: 0 }
    existing.lastRemoteUpdate = Date.now()
    this.syncTimings.set(noteId, existing)
  }

  private recordExternalUpdate(noteId: string): void {
    const existing = this.syncTimings.get(noteId) ?? { lastRemoteUpdate: 0, lastExternalUpdate: 0 }
    existing.lastExternalUpdate = Date.now()
    this.syncTimings.set(noteId, existing)
  }

  private detectConflict(noteId: string, source: 'external' | 'remote'): boolean {
    const timing = this.syncTimings.get(noteId)
    if (!timing) return false

    const other = source === 'external' ? timing.lastRemoteUpdate : timing.lastExternalUpdate

    return Date.now() - other < CrdtProvider.CONFLICT_WINDOW_MS
  }

  private emitExternalConflictEvent(noteId: string): void {
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send(SyncChannels.events.EXTERNAL_SYNC_CONFLICT, {
        noteId,
        resolution: 'crdt-wins',
        frontmatterSource: 'external'
      })
    })
  }

  // =========================================================================
  // Loop Prevention
  // =========================================================================

  markCrdtWrite(noteId: string): void {
    this.recentCrdtWrites.set(noteId, Date.now())
    setTimeout(() => this.recentCrdtWrites.delete(noteId), 2000)
  }

  wasRecentCrdtWrite(noteId: string): boolean {
    const writeTime = this.recentCrdtWrites.get(noteId)
    return writeTime !== undefined && Date.now() - writeTime < 1500
  }

  // =========================================================================
  // T140l/T140m: External File Change Application
  // =========================================================================

  async applyExternalFileChange(
    noteId: string,
    markdownContent: string,
    frontmatter: Record<string, unknown>,
    options: { syncWasActive: boolean }
  ): Promise<void> {
    this.ensureInitialized()

    // Record external change timing
    this.recordExternalChange(noteId)
    this.recordExternalUpdate(noteId)

    // Detect conflict if sync was active
    if (options.syncWasActive && this.detectConflict(noteId, 'external')) {
      this.emitExternalConflictEvent(noteId)
    }

    try {
      // Get or create the Y.Doc for this note
      const doc = await this.getOrCreateDoc(noteId)

      // Apply the markdown content as a Yjs text update
      // Since BlockNote conversion requires renderer, we store raw markdown in a text field
      // and let the renderer convert it to blocks when the note is opened
      const contentText = doc.getText('content')

      doc.transact(() => {
        contentText.delete(0, contentText.length)
        contentText.insert(0, markdownContent)
      }, 'external')

      // Store frontmatter in the doc's meta map (external file wins for frontmatter)
      const metaMap = doc.getMap('meta')
      doc.transact(() => {
        for (const [key, value] of Object.entries(frontmatter)) {
          if (value !== undefined) {
            metaMap.set(key, value)
          }
        }
      }, 'external')
    } catch (error) {
      console.error(`[CrdtProvider] Failed to apply external change for ${noteId}:`, error)
      throw error
    }
  }

  async seedDocFromMarkdown(
    noteId: string,
    markdownContent: string,
    frontmatter: Record<string, unknown>
  ): Promise<void> {
    this.ensureInitialized()

    try {
      const doc = await this.getOrCreateDoc(noteId)
      const contentText = doc.getText('content')
      const metaMap = doc.getMap('meta')

      doc.transact(() => {
        contentText.delete(0, contentText.length)
        if (markdownContent) {
          contentText.insert(0, markdownContent)
        }

        for (const [key, value] of Object.entries(frontmatter)) {
          if (value !== undefined) {
            metaMap.set(key, value)
          }
        }
      }, 'bootstrap')
    } catch (error) {
      console.error(`[CrdtProvider] Failed to seed doc for ${noteId}:`, error)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return

    this.shuttingDown = true

    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }

    if (this.proactiveGcTimer) {
      clearInterval(this.proactiveGcTimer)
      this.proactiveGcTimer = null
    }

    const flushPromises = Array.from(this.docs.keys()).map((noteId) =>
      this.persistence!.flushDocument(noteId).catch((error) => {
        console.warn('[CrdtProvider] Flush failed during shutdown:', noteId, error)
      })
    )
    await Promise.all(flushPromises)

    for (const entry of this.docs.values()) {
      entry.doc.destroy()
    }
    this.docs.clear()
    this.docCreationLocks.clear()
    this.externalChangeTimes.clear()
    this.syncTimings.clear()
    this.recentCrdtWrites.clear()

    await this.persistence?.destroy()
    this.persistence = null
    this.dbReady = null
    this.initialized = false
    this.shuttingDown = false

    console.info('[CrdtProvider] Shut down')
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.persistence) {
      throw new Error('CrdtProvider not initialized')
    }
  }
}

let crdtProviderInstance: CrdtProvider | null = null

export function getCrdtProvider(): CrdtProvider | null {
  return crdtProviderInstance
}

export async function initializeCrdtProvider(customDbPath?: string): Promise<CrdtProvider> {
  if (!crdtProviderInstance) {
    crdtProviderInstance = new CrdtProvider()
  }
  await crdtProviderInstance.initialize(customDbPath)
  return crdtProviderInstance
}

export async function shutdownCrdtProvider(): Promise<void> {
  if (crdtProviderInstance) {
    await crdtProviderInstance.shutdown()
    crdtProviderInstance = null
  }
}

export { base64ToUint8Array } from '@shared/utils/encoding'
