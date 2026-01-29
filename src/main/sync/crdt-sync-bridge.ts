/**
 * CRDT Sync Bridge
 *
 * Bridges local CrdtProvider updates to the sync server.
 * Batches and debounces updates, handles offline scenarios,
 * and manages sequence numbers for sync ordering.
 *
 * @module sync/crdt-sync-bridge
 */

import type { CrdtProvider } from './crdt-provider'
import { getSyncApiClient, isSyncApiError } from './api-client'
import { getNetworkMonitor } from './network'
import { getSyncQueue } from './queue'
import { getSyncEngine } from './engine'
import { uint8ArrayToBase64, base64ToUint8Array } from '@shared/utils/encoding'
import type { CrdtUpdatePush } from '@shared/contracts/crdt-api'
import { getNoteById } from '../vault/notes'
import { getJournalEntryById } from '../vault/journal'
import { retrieveDeviceKeyPair } from '../crypto/keychain'
import { refreshAccessToken } from './token-refresh'
import { emptyClock, incrementClock } from './vector-clock'

const LOG_PREFIX = '[CrdtSyncBridge]'
const DEBOUNCE_MS = 1500
const MAX_BATCH_SIZE = 50
const RETRY_DELAY_MS = 5000
const MAX_RETRIES = 3

interface PendingUpdate {
  noteId: string
  update: Uint8Array
  timestamp: number
}

interface NoteSequenceState {
  localSequence: number
  serverSequence: number
}

export class CrdtSyncBridge {
  private crdtProvider: CrdtProvider | null = null
  private pendingUpdates: Map<string, PendingUpdate[]> = new Map()
  private sequenceState: Map<string, NoteSequenceState> = new Map()
  private debounceTimer: NodeJS.Timeout | null = null
  private flushInProgress = false
  private offlineQueue: CrdtUpdatePush[] = []
  private initialized = false
  private recentUpdateHashes: Set<string> = new Set()
  private syncedNotes: Set<string> = new Set()
  private pendingNoteSyncs: Map<string, Promise<boolean>> = new Map()

  initialize(crdtProvider: CrdtProvider): void {
    if (this.initialized) {
      console.warn(`${LOG_PREFIX} Already initialized`)
      return
    }

    this.crdtProvider = crdtProvider
    this.initialized = true

    crdtProvider.on('crdt:doc-updated', (payload) => {
      if (payload.origin !== 'remote') {
        this.onDocUpdated(payload.noteId, payload.update)
      }
    })

    const networkMonitor = getNetworkMonitor()
    networkMonitor.on('sync:connectivity-changed', (isOnline) => {
      if (isOnline && this.offlineQueue.length > 0) {
        console.info(`${LOG_PREFIX} Back online, flushing offline queue`)
        void this.flushOfflineQueue()
      }
    })

    console.info(`${LOG_PREFIX} Initialized`)
  }

  private computeUpdateHash(noteId: string, update: Uint8Array): string {
    const prefix = Array.from(update.slice(0, 8)).join(',')
    const suffix = Array.from(update.slice(-8)).join(',')
    return `${noteId}:${update.length}:${prefix}:${suffix}`
  }

  private async ensureNoteSynced(docId: string): Promise<boolean> {
    if (this.syncedNotes.has(docId)) {
      return true
    }

    const existing = this.pendingNoteSyncs.get(docId)
    if (existing) {
      return existing
    }

    const syncPromise = this.isJournalId(docId)
      ? this.syncJournalToServer(docId)
      : this.syncNoteToServer(docId)
    this.pendingNoteSyncs.set(docId, syncPromise)

    try {
      const result = await syncPromise
      if (result) {
        this.syncedNotes.add(docId)
      }
      return result
    } finally {
      this.pendingNoteSyncs.delete(docId)
    }
  }

  private async syncNoteToServer(noteId: string): Promise<boolean> {
    try {
      const note = await getNoteById(noteId)
      if (!note) {
        console.warn(`${LOG_PREFIX} Note ${noteId} not found locally, cannot sync`)
        return false
      }

      const keyPair = await retrieveDeviceKeyPair().catch(() => null)
      if (!keyPair?.deviceId) {
        console.warn(`${LOG_PREFIX} No device keypair, cannot sync note ${noteId}`)
        return false
      }

      const clock = incrementClock(emptyClock(), keyPair.deviceId)
      const payload = {
        id: note.id,
        title: note.title,
        path: note.path,
        created: note.created.toISOString(),
        modified: note.modified.toISOString(),
        clock
      }

      const queue = getSyncQueue()
      await queue.add('note', noteId, 'create', JSON.stringify(payload), 10)

      const engine = getSyncEngine()
      if (engine && this.isOnline()) {
        console.info(`${LOG_PREFIX} Syncing note ${noteId} before CRDT updates`)
        await engine.push()
      }

      return true
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to sync note ${noteId}:`, error)
      return false
    }
  }

  private isJournalId(docId: string): boolean {
    return /^j\d{4}-\d{2}-\d{2}$/.test(docId)
  }

  private async syncJournalToServer(journalId: string): Promise<boolean> {
    try {
      const entry = await getJournalEntryById(journalId)
      if (!entry) {
        console.warn(`${LOG_PREFIX} Journal ${journalId} not found locally, cannot sync`)
        return false
      }

      const keyPair = await retrieveDeviceKeyPair().catch(() => null)
      if (!keyPair?.deviceId) {
        console.warn(`${LOG_PREFIX} No device keypair, cannot sync journal ${journalId}`)
        return false
      }

      const clock = incrementClock(emptyClock(), keyPair.deviceId)
      const payload = {
        id: entry.id,
        date: entry.date,
        created: entry.createdAt,
        modified: entry.modifiedAt,
        tags: entry.tags,
        properties: entry.properties ?? {},
        clock
      }

      const queue = getSyncQueue()
      await queue.add('journal', journalId, 'create', JSON.stringify(payload), 10)

      const engine = getSyncEngine()
      if (engine && this.isOnline()) {
        console.info(`${LOG_PREFIX} Syncing journal ${journalId} before CRDT updates`)
        await engine.push()
      }

      return true
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to sync journal ${journalId}:`, error)
      return false
    }
  }

  private onDocUpdated(noteId: string, update: Uint8Array): void {
    if (!this.isReady()) {
      return
    }

    console.debug(`${LOG_PREFIX} onDocUpdated:`, { noteId, updateSize: update.length })

    const hash = this.computeUpdateHash(noteId, update)
    if (this.recentUpdateHashes.has(hash)) {
      console.debug(`${LOG_PREFIX} Skipping duplicate update:`, { noteId, hash })
      return
    }

    this.recentUpdateHashes.add(hash)
    setTimeout(() => this.recentUpdateHashes.delete(hash), DEBOUNCE_MS + 500)

    const pending = this.pendingUpdates.get(noteId) ?? []
    pending.push({ noteId, update, timestamp: Date.now() })
    this.pendingUpdates.set(noteId, pending)

    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      void this.flushUpdates()
    }, DEBOUNCE_MS)
  }

  private async flushUpdates(): Promise<void> {
    if (this.flushInProgress || this.pendingUpdates.size === 0) {
      return
    }

    this.flushInProgress = true

    try {
      const noteIds = [...this.pendingUpdates.keys()]
      const syncResults = await Promise.all(
        noteIds.map(async (noteId) => ({
          noteId,
          synced: await this.ensureNoteSynced(noteId)
        }))
      )

      const failedNotes = new Set(syncResults.filter((r) => !r.synced).map((r) => r.noteId))

      if (failedNotes.size > 0) {
        console.warn(`${LOG_PREFIX} Skipping CRDT updates for unsynced notes:`, [...failedNotes])
      }

      const allUpdates: CrdtUpdatePush[] = []

      for (const [noteId, updates] of this.pendingUpdates) {
        if (failedNotes.has(noteId)) {
          continue
        }

        const state = this.getSequenceState(noteId)

        for (const pending of updates) {
          state.localSequence++
          allUpdates.push({
            noteId,
            updateData: uint8ArrayToBase64(pending.update),
            sequenceNum: state.localSequence
          })
        }

        this.sequenceState.set(noteId, state)
      }

      this.pendingUpdates.clear()

      if (allUpdates.length === 0) {
        return
      }

      if (!this.isOnline()) {
        console.info(`${LOG_PREFIX} Offline, queueing ${allUpdates.length} updates`)
        this.offlineQueue.push(...allUpdates)
        return
      }

      await this.pushUpdatesToServer(allUpdates)
    } catch (error) {
      console.error(`${LOG_PREFIX} Flush failed:`, error)
    } finally {
      this.flushInProgress = false
    }
  }

  private async pushUpdatesToServer(updates: CrdtUpdatePush[]): Promise<void> {
    if (updates.length === 0) return

    const batches: CrdtUpdatePush[][] = []
    for (let i = 0; i < updates.length; i += MAX_BATCH_SIZE) {
      batches.push(updates.slice(i, i + MAX_BATCH_SIZE))
    }

    const client = getSyncApiClient()

    for (const batch of batches) {
      let retries = 0
      let authRefreshed = false

      while (retries < MAX_RETRIES) {
        try {
          const result = await client.pushCrdtUpdates(batch)

          if (result.rejected.length > 0) {
            console.warn(`${LOG_PREFIX} Some updates rejected:`, result.rejected)
          }

          for (const accepted of result.accepted) {
            const state = this.getSequenceState(accepted.noteId)
            state.serverSequence = Math.max(state.serverSequence, accepted.sequenceNum)
            this.sequenceState.set(accepted.noteId, state)
          }

          console.info(`${LOG_PREFIX} Pushed ${result.accepted.length} updates`)
          break
        } catch (error) {
          if (this.isAuthError(error) && !authRefreshed) {
            console.info(`${LOG_PREFIX} Auth expired, attempting refresh`)
            const refreshed = await this.tryRefreshSession()
            if (refreshed) {
              authRefreshed = true
              continue
            }
            console.warn(`${LOG_PREFIX} Auth refresh failed, queueing updates offline`)
            this.offlineQueue.push(...batch)
            return
          }

          retries++

          if (retries >= MAX_RETRIES) {
            console.error(`${LOG_PREFIX} Max retries reached, queueing offline:`, error)
            this.offlineQueue.push(...batch)
            return
          }

          console.warn(`${LOG_PREFIX} Push failed, retry ${retries}/${MAX_RETRIES}:`, error)
          await this.delay(RETRY_DELAY_MS * retries)
        }
      }
    }
  }

  private async flushOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0 || !this.isOnline()) {
      return
    }

    const updates = [...this.offlineQueue]
    this.offlineQueue = []

    await this.pushUpdatesToServer(updates)
  }

  async pushSnapshot(noteId: string, snapshot: Uint8Array): Promise<void> {
    if (!this.isReady() || !this.isOnline()) {
      return
    }

    const state = this.getSequenceState(noteId)
    const client = getSyncApiClient()

    try {
      const result = await this.withAuthRefresh(() =>
        client.pushCrdtSnapshot(
          noteId,
          uint8ArrayToBase64(snapshot),
          state.localSequence,
          snapshot.length
        )
      )

      state.serverSequence = result.sequenceNum
      this.sequenceState.set(noteId, state)

      console.info(`${LOG_PREFIX} Pushed snapshot for ${noteId}:`, {
        sequenceNum: result.sequenceNum,
        updatesPruned: result.updatesPruned
      })
    } catch (error) {
      console.error(`${LOG_PREFIX} Snapshot push failed for ${noteId}:`, error)
    }
  }

  async pullUpdatesForNote(noteId: string): Promise<void> {
    if (!this.crdtProvider || !this.isOnline()) {
      return
    }

    const state = this.getSequenceState(noteId)
    const client = getSyncApiClient()

    try {
      const result = await this.withAuthRefresh(() =>
        client.pullCrdtUpdates(noteId, state.serverSequence)
      )

      if (result.updates.length === 0) {
        return
      }

      console.info(`${LOG_PREFIX} Pulled ${result.updates.length} updates for ${noteId}`)

      for (const update of result.updates) {
        const bytes = base64ToUint8Array(update.updateData)
        this.crdtProvider.applyUpdate(noteId, bytes, 'remote')
        state.serverSequence = Math.max(state.serverSequence, update.sequenceNum)
      }

      this.sequenceState.set(noteId, state)
    } catch (error) {
      console.error(`${LOG_PREFIX} Pull updates failed for ${noteId}:`, error)
    }
  }

  async pullSnapshotForNote(noteId: string): Promise<boolean> {
    if (!this.crdtProvider || !this.isOnline()) {
      return false
    }

    const client = getSyncApiClient()

    try {
      const result = await this.withAuthRefresh(() => client.pullCrdtSnapshot(noteId))

      if (!result.exists || !result.snapshotData) {
        return false
      }

      console.info(`${LOG_PREFIX} Pulled snapshot for ${noteId}:`, {
        sequenceNum: result.sequenceNum,
        sizeBytes: result.sizeBytes
      })

      const bytes = base64ToUint8Array(result.snapshotData)
      this.crdtProvider.applyUpdate(noteId, bytes, 'remote')

      const state = this.getSequenceState(noteId)
      state.serverSequence = result.sequenceNum
      this.sequenceState.set(noteId, state)

      return true
    } catch (error) {
      console.error(`${LOG_PREFIX} Pull snapshot failed for ${noteId}:`, error)
      return false
    }
  }

  async syncAllDocs(): Promise<void> {
    if (!this.crdtProvider || !this.isOnline()) {
      return
    }

    const docNames = await this.crdtProvider.getAllDocNames()
    console.info(`${LOG_PREFIX} Syncing ${docNames.length} documents`)

    for (const noteId of docNames) {
      await this.pullUpdatesForNote(noteId)
    }
  }

  private getSequenceState(noteId: string): NoteSequenceState {
    const existing = this.sequenceState.get(noteId)
    if (existing) {
      return existing
    }

    const state: NoteSequenceState = {
      localSequence: 0,
      serverSequence: 0
    }
    this.sequenceState.set(noteId, state)
    return state
  }

  private isReady(): boolean {
    return this.initialized && this.crdtProvider !== null
  }

  private isOnline(): boolean {
    return getNetworkMonitor().isOnline()
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private isAuthError(error: unknown): boolean {
    return isSyncApiError(error) && error.status === 401
  }

  private async tryRefreshSession(): Promise<boolean> {
    return refreshAccessToken()
  }

  private async withAuthRefresh<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error
      }
      const refreshed = await this.tryRefreshSession()
      if (!refreshed) {
        throw error
      }
      return operation()
    }
  }

  shutdown(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.pendingUpdates.clear()
    this.offlineQueue = []
    this.recentUpdateHashes.clear()
    this.syncedNotes.clear()
    this.pendingNoteSyncs.clear()
    this.lastRefreshAttempt = 0
    this.refreshPromise = null
    this.initialized = false
    this.crdtProvider = null

    console.info(`${LOG_PREFIX} Shutdown complete`)
  }

  getOfflineQueueSize(): number {
    return this.offlineQueue.length
  }

  getPendingUpdateCount(): number {
    let count = 0
    for (const updates of this.pendingUpdates.values()) {
      count += updates.length
    }
    return count
  }
}

let crdtSyncBridgeInstance: CrdtSyncBridge | null = null

export function getCrdtSyncBridge(): CrdtSyncBridge | null {
  return crdtSyncBridgeInstance
}

export function initializeCrdtSyncBridge(): CrdtSyncBridge {
  if (!crdtSyncBridgeInstance) {
    crdtSyncBridgeInstance = new CrdtSyncBridge()
  }
  return crdtSyncBridgeInstance
}

export function shutdownCrdtSyncBridge(): void {
  if (crdtSyncBridgeInstance) {
    crdtSyncBridgeInstance.shutdown()
    crdtSyncBridgeInstance = null
  }
}
