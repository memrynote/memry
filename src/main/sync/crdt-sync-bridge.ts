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
import { getNotesByIds, type Note } from '../vault/notes'
import { getJournalEntriesByIds } from '../vault/journal'
import type { JournalEntry } from '@shared/contracts/journal-api'
import { retrieveDeviceKeyPair } from '../crypto/keychain'
import { sign, verify } from '../crypto/signatures'
import { getDatabase } from '../database'
import { devices, crdtSequenceState } from '@shared/db/schema/sync-schema'
import { eq } from 'drizzle-orm'
import { refreshAccessToken } from './token-refresh'
import { emptyClock, incrementClock } from './vector-clock'
import { isSyncAuthReady } from './auth-state'
import { fetchAndStoreAccountDevices } from '../ipc/sync-handlers'

const LOG_PREFIX = '[CrdtSyncBridge]'
const DEVICE_REFRESH_COOLDOWN_MS = 30000
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
  lastKnownSequence: number
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
  private docUpdatedListener:
    | ((payload: { noteId: string; update: Uint8Array; origin: string }) => void)
    | null = null
  private connectivityListener: ((isOnline: boolean) => void) | null = null
  private deviceRefreshInProgress = false
  private lastDeviceRefresh = 0

  initialize(crdtProvider: CrdtProvider): void {
    if (this.initialized) {
      console.warn(`${LOG_PREFIX} Already initialized`)
      return
    }

    this.crdtProvider = crdtProvider
    this.initialized = true

    this.docUpdatedListener = (payload) => {
      // Skip 'remote' (received from server) and 'external' (file watcher after resync write)
      if (payload.origin !== 'remote' && payload.origin !== 'external') {
        this.onDocUpdated(payload.noteId, payload.update)
      }
    }
    crdtProvider.on('crdt:doc-updated', this.docUpdatedListener)

    const networkMonitor = getNetworkMonitor()
    this.connectivityListener = (isOnline) => {
      if (isOnline && this.offlineQueue.length > 0) {
        console.info(`${LOG_PREFIX} Back online, flushing offline queue`)
        void this.flushOfflineQueue()
      }
    }
    networkMonitor.on('sync:connectivity-changed', this.connectivityListener)

    console.info(`${LOG_PREFIX} Initialized`)
  }

  private computeUpdateHash(noteId: string, update: Uint8Array): string {
    const prefix = Array.from(update.slice(0, 8)).join(',')
    const suffix = Array.from(update.slice(-8)).join(',')
    return `${noteId}:${update.length}:${prefix}:${suffix}`
  }

  private isJournalId(docId: string): boolean {
    return /^j\d{4}-\d{2}-\d{2}$/.test(docId)
  }

  private async syncItemToServer(itemId: string, data: Note | JournalEntry): Promise<boolean> {
    try {
      const keyPair = await retrieveDeviceKeyPair().catch((err) => {
        console.warn(`${LOG_PREFIX} Failed to retrieve device keypair:`, err)
        return null
      })
      if (!keyPair?.deviceId) {
        console.warn(`${LOG_PREFIX} No device keypair, cannot sync item ${itemId}`)
        return false
      }

      const clock = incrementClock(emptyClock(), keyPair.deviceId)
      const queue = getSyncQueue()

      if (this.isJournalId(itemId)) {
        const entry = data as JournalEntry
        const payload = {
          id: entry.id,
          date: entry.date,
          created: entry.createdAt,
          modified: entry.modifiedAt,
          tags: entry.tags,
          properties: entry.properties ?? {},
          clock
        }
        await queue.add('journal', itemId, 'create', JSON.stringify(payload), 10)
      } else {
        const note = data as Note
        const payload = {
          id: note.id,
          title: note.title,
          path: note.path,
          created: note.created.toISOString(),
          modified: note.modified.toISOString(),
          tags: note.tags,
          aliases: note.aliases,
          emoji: note.emoji ?? null,
          properties: note.properties ?? {},
          clock
        }
        await queue.add('note', itemId, 'create', JSON.stringify(payload), 10)
      }

      const engine = getSyncEngine()
      if (engine && this.isOnline()) {
        console.info(`${LOG_PREFIX} Syncing item ${itemId} before CRDT updates`)
        await engine.push()
      }

      return true
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to sync item ${itemId}:`, error)
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
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Flush skipped: not authenticated`)
      return
    }

    this.flushInProgress = true

    try {
      const keyPair = await retrieveDeviceKeyPair().catch(() => null)
      if (!keyPair?.deviceId) {
        console.warn(`${LOG_PREFIX} No device keypair, cannot sign CRDT updates`)
        return
      }

      const noteIds = [...this.pendingUpdates.keys()]

      const journalIds = noteIds.filter((id) => this.isJournalId(id))
      const regularNoteIds = noteIds.filter((id) => !this.isJournalId(id))

      const [notes, journals] = await Promise.all([
        getNotesByIds(regularNoteIds),
        getJournalEntriesByIds(journalIds)
      ])

      const notesMap = new Map(notes.map((n) => [n.id, n]))
      const journalsMap = new Map(journals.map((j) => [j.id, j]))

      const failedNotes = new Set<string>()

      for (const noteId of noteIds) {
        const alreadySynced = this.syncedNotes.has(noteId)
        if (alreadySynced) continue

        const data = this.isJournalId(noteId) ? journalsMap.get(noteId) : notesMap.get(noteId)

        if (!data) {
          failedNotes.add(noteId)
          continue
        }

        const synced = await this.syncItemToServer(noteId, data)
        if (synced) {
          this.syncedNotes.add(noteId)
        } else {
          failedNotes.add(noteId)
        }
      }

      if (failedNotes.size > 0) {
        console.warn(`${LOG_PREFIX} Skipping CRDT updates for unsynced notes:`, [...failedNotes])
      }

      const allUpdates: CrdtUpdatePush[] = []

      for (const [noteId, updates] of this.pendingUpdates) {
        if (failedNotes.has(noteId)) {
          continue
        }

        for (const pending of updates) {
          const signature = await sign(pending.update, keyPair.privateKey)

          allUpdates.push({
            noteId,
            updateData: uint8ArrayToBase64(pending.update),
            signature: uint8ArrayToBase64(signature),
            signerDeviceId: keyPair.deviceId
          })
        }
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

    const results = await Promise.all(
      batches.map((batch, index) => this.processBatchWithRetry(batch, index))
    )

    const failedBatches = results.filter((r) => !r.success)
    if (failedBatches.length > 0) {
      console.warn(`${LOG_PREFIX} ${failedBatches.length}/${batches.length} batches failed`)
    }
  }

  private async processBatchWithRetry(
    batch: CrdtUpdatePush[],
    batchIndex: number
  ): Promise<{ success: boolean; batch: CrdtUpdatePush[] }> {
    const client = getSyncApiClient()
    let retries = 0
    let authRefreshed = false

    while (retries < MAX_RETRIES) {
      try {
        const result = await client.pushCrdtUpdates(batch)

        if (result.rejected.length > 0) {
          console.warn(`${LOG_PREFIX} Batch ${batchIndex}: Some updates rejected:`, result.rejected)
        }

        for (const accepted of result.accepted) {
          const state = this.getSequenceState(accepted.noteId)
          state.lastKnownSequence = Math.max(state.lastKnownSequence, accepted.sequenceNum)
          this.sequenceState.set(accepted.noteId, state)
          this.persistSequenceState(accepted.noteId, state)
        }

        console.info(`${LOG_PREFIX} Batch ${batchIndex}: Pushed ${result.accepted.length} updates`)
        return { success: true, batch }
      } catch (error) {
        if (this.isAuthError(error) && !authRefreshed) {
          console.info(`${LOG_PREFIX} Batch ${batchIndex}: Auth expired, attempting refresh`)
          const refreshed = await this.tryRefreshSession()
          if (refreshed) {
            authRefreshed = true
            continue
          }
          console.warn(`${LOG_PREFIX} Batch ${batchIndex}: Auth refresh failed, queueing offline`)
          this.offlineQueue.push(...batch)
          return { success: false, batch }
        }

        retries++

        if (retries >= MAX_RETRIES) {
          console.error(
            `${LOG_PREFIX} Batch ${batchIndex}: Max retries reached, queueing offline:`,
            error
          )
          this.offlineQueue.push(...batch)
          return { success: false, batch }
        }

        console.warn(
          `${LOG_PREFIX} Batch ${batchIndex}: Push failed, retry ${retries}/${MAX_RETRIES}:`,
          error
        )
        await this.delay(RETRY_DELAY_MS * retries)
      }
    }

    return { success: false, batch }
  }

  private async flushOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0 || !this.isOnline()) {
      return
    }
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Offline queue flush skipped: not authenticated`)
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
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Snapshot push skipped: not authenticated`)
      return
    }

    const state = this.getSequenceState(noteId)
    const sequenceNum = Math.max(state.lastKnownSequence, 1)
    const client = getSyncApiClient()

    try {
      const result = await this.withAuthRefresh(() =>
        client.pushCrdtSnapshot(noteId, uint8ArrayToBase64(snapshot), sequenceNum, snapshot.length)
      )

      state.lastKnownSequence = result.sequenceNum
      this.sequenceState.set(noteId, state)
      this.persistSequenceState(noteId, state)

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
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Pull updates skipped: not authenticated`)
      return
    }

    const state = this.getSequenceState(noteId)
    const client = getSyncApiClient()

    try {
      await this.crdtProvider.getOrCreateDoc(noteId)

      const result = await this.withAuthRefresh(() =>
        client.pullCrdtUpdates(noteId, state.lastKnownSequence)
      )

      if (result.updates.length === 0) {
        return
      }

      console.info(`${LOG_PREFIX} Pulled ${result.updates.length} updates for ${noteId}`)

      let appliedCount = 0
      for (const update of result.updates) {
        const bytes = base64ToUint8Array(update.updateData)

        let publicKey = await this.getDevicePublicKey(update.signerDeviceId)

        if (!publicKey) {
          await this.refreshDeviceList()
          publicKey = await this.getDevicePublicKey(update.signerDeviceId)
        }

        if (!publicKey) {
          console.error(
            `${LOG_PREFIX} Unknown signer device ${update.signerDeviceId}, rejecting update`
          )
          continue
        }

        const signatureBytes = base64ToUint8Array(update.signature)
        const isValid = await verify(bytes, signatureBytes, publicKey)
        if (!isValid) {
          console.error(
            `${LOG_PREFIX} Invalid signature on CRDT update from ${update.signerDeviceId}, rejecting`
          )
          continue
        }

        this.crdtProvider.applyUpdate(noteId, bytes, 'remote')
        state.lastKnownSequence = Math.max(state.lastKnownSequence, update.sequenceNum)
        appliedCount++
      }

      this.sequenceState.set(noteId, state)
      this.persistSequenceState(noteId, state)

      if (appliedCount > 0) {
        const { resyncNoteContentFromCrdt } = await import('../ipc/sync-handlers')
        await resyncNoteContentFromCrdt(noteId)
      }
    } catch (error) {
      if (this.isForbiddenError(error)) {
        console.info(`${LOG_PREFIX} Pull updates skipped for ${noteId}: note not on server yet`)
        return
      }
      console.error(`${LOG_PREFIX} Pull updates failed for ${noteId}:`, error)
    }
  }

  async pullSnapshotForNote(noteId: string): Promise<boolean> {
    if (!this.crdtProvider || !this.isOnline()) {
      return false
    }
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Pull snapshot skipped: not authenticated`)
      return false
    }

    const client = getSyncApiClient()

    try {
      await this.crdtProvider.getOrCreateDoc(noteId)

      const result = await this.withAuthRefresh(() => client.pullCrdtSnapshot(noteId))

      if (!result.exists || !result.snapshotData) {
        return false
      }

      console.info(`${LOG_PREFIX} Pulled snapshot for ${noteId}:`, {
        sequenceNum: result.sequenceNum,
        sizeBytes: result.sizeBytes
      })

      const bytes = base64ToUint8Array(result.snapshotData)
      this.crdtProvider.applySnapshot(noteId, bytes)

      const state = this.getSequenceState(noteId)
      state.lastKnownSequence = result.sequenceNum
      this.sequenceState.set(noteId, state)
      this.persistSequenceState(noteId, state)

      return true
    } catch (error) {
      if (this.isForbiddenError(error)) {
        console.info(`${LOG_PREFIX} Pull snapshot skipped for ${noteId}: note not on server yet`)
        return false
      }
      console.error(`${LOG_PREFIX} Pull snapshot failed for ${noteId}:`, error)
      return false
    }
  }

  async pushInitialNote(noteId: string, note: Note | JournalEntry): Promise<void> {
    if (!this.crdtProvider || !this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Initial sync skipped: not ready`)
      return
    }

    const synced = await this.syncItemToServer(noteId, note)
    if (!synced) {
      console.warn(`${LOG_PREFIX} Failed to sync initial note metadata: ${noteId}`)
      return
    }
    this.syncedNotes.add(noteId)

    const update = this.crdtProvider.encodeSnapshot(noteId, false)
    if (update.length === 0) return

    this.onDocUpdated(noteId, update)
    this.scheduleFlush()
  }

  async pullUpdatesForAllLoadedDocs(): Promise<void> {
    if (!this.crdtProvider || !this.isOnline() || !this.isAuthReady()) {
      return
    }

    const loadedDocIds = this.crdtProvider.getLoadedDocIds()

    if (loadedDocIds.length === 0) {
      return
    }

    console.info(`${LOG_PREFIX} Pulling updates for ${loadedDocIds.length} loaded docs`)

    await Promise.all(loadedDocIds.map((noteId) => this.pullUpdatesForNote(noteId)))
  }

  async syncAllDocs(): Promise<void> {
    if (!this.crdtProvider || !this.isOnline()) {
      return
    }
    if (!this.isAuthReady()) {
      console.debug(`${LOG_PREFIX} Sync all docs skipped: not authenticated`)
      return
    }

    const docNames = await this.crdtProvider.getAllDocNames()
    console.info(`${LOG_PREFIX} Syncing ${docNames.length} documents`)

    for (const noteId of docNames) {
      await this.pullUpdatesForNote(noteId)
    }
  }

  async bootstrapLocalDocs(): Promise<{ notes: number; journals: number }> {
    if (!this.crdtProvider || !this.isOnline()) {
      console.info(`${LOG_PREFIX} Bootstrap skipped: not ready or offline`)
      return { notes: 0, journals: 0 }
    }

    if (!this.isAuthReady()) {
      console.info(`${LOG_PREFIX} Bootstrap skipped: not authenticated`)
      return { notes: 0, journals: 0 }
    }

    const docNames = await this.crdtProvider.getAllDocNames()
    if (docNames.length === 0) {
      console.info(`${LOG_PREFIX} No local documents to bootstrap`)
      return { notes: 0, journals: 0 }
    }

    console.info(`${LOG_PREFIX} Bootstrapping ${docNames.length} local documents`)

    let notes = 0
    let journals = 0

    for (const noteId of docNames) {
      try {
        const doc = this.crdtProvider.getDoc(noteId)
        if (!doc) {
          console.warn(`${LOG_PREFIX} Doc not loaded for bootstrap: ${noteId}`)
          continue
        }

        const isJournal = this.isJournalId(noteId)

        const noteData = isJournal
          ? await getJournalEntriesByIds([noteId]).then((entries) => entries[0])
          : await getNotesByIds([noteId]).then((notes) => notes[0])

        if (!noteData) {
          console.warn(`${LOG_PREFIX} No note/journal data found for: ${noteId}`)
          continue
        }

        const synced = await this.syncItemToServer(noteId, noteData)
        if (!synced) {
          console.warn(`${LOG_PREFIX} Failed to sync metadata for: ${noteId}`)
          continue
        }

        const snapshot = this.crdtProvider.encodeSnapshot(noteId, true)
        await this.pushSnapshot(noteId, snapshot)

        if (isJournal) {
          journals++
        } else {
          notes++
        }

        console.debug(`${LOG_PREFIX} Bootstrapped ${isJournal ? 'journal' : 'note'}: ${noteId}`)
      } catch (error) {
        console.error(`${LOG_PREFIX} Bootstrap failed for ${noteId}:`, error)
      }
    }

    console.info(`${LOG_PREFIX} Bootstrap complete:`, { notes, journals })
    return { notes, journals }
  }

  private getSequenceState(noteId: string): NoteSequenceState {
    const cached = this.sequenceState.get(noteId)
    if (cached) {
      return cached
    }

    const db = getDatabase()
    const row = db
      .select({ lastKnownSequence: crdtSequenceState.lastKnownSequence })
      .from(crdtSequenceState)
      .where(eq(crdtSequenceState.noteId, noteId))
      .get()

    const state: NoteSequenceState = {
      lastKnownSequence: row?.lastKnownSequence ?? 0
    }
    this.sequenceState.set(noteId, state)
    return state
  }

  private persistSequenceState(noteId: string, state: NoteSequenceState): void {
    const db = getDatabase()
    const now = new Date().toISOString()
    db.insert(crdtSequenceState)
      .values({
        noteId,
        lastKnownSequence: state.lastKnownSequence,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: crdtSequenceState.noteId,
        set: {
          lastKnownSequence: state.lastKnownSequence,
          updatedAt: now
        }
      })
      .run()
  }

  private async refreshDeviceList(): Promise<void> {
    const now = Date.now()
    if (this.deviceRefreshInProgress || now - this.lastDeviceRefresh < DEVICE_REFRESH_COOLDOWN_MS) {
      return
    }

    this.deviceRefreshInProgress = true
    try {
      console.info(`${LOG_PREFIX} Refreshing device list from server`)
      await fetchAndStoreAccountDevices()
      this.lastDeviceRefresh = now
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to refresh device list:`, error)
    } finally {
      this.deviceRefreshInProgress = false
    }
  }

  private async getDevicePublicKey(deviceId: string): Promise<Uint8Array | null> {
    const deviceKeyPair = await retrieveDeviceKeyPair().catch(() => null)

    if (deviceKeyPair?.deviceId === deviceId) {
      return deviceKeyPair.publicKey
    }

    const db = getDatabase()
    const rows = await db
      .select({ authPublicKey: devices.authPublicKey })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)

    if (!rows[0]?.authPublicKey) {
      return null
    }

    return base64ToUint8Array(rows[0].authPublicKey)
  }

  private isReady(): boolean {
    return this.initialized && this.crdtProvider !== null
  }

  private isAuthReady(): boolean {
    return isSyncAuthReady()
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

  private isForbiddenError(error: unknown): boolean {
    return isSyncApiError(error) && error.status === 403
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

    if (this.docUpdatedListener && this.crdtProvider) {
      this.crdtProvider.off('crdt:doc-updated', this.docUpdatedListener)
      this.docUpdatedListener = null
    }

    if (this.connectivityListener) {
      const networkMonitor = getNetworkMonitor()
      networkMonitor.off('sync:connectivity-changed', this.connectivityListener)
      this.connectivityListener = null
    }

    this.pendingUpdates.clear()
    this.offlineQueue = []
    this.recentUpdateHashes.clear()
    this.syncedNotes.clear()
    this.pendingNoteSyncs.clear()
    this.sequenceState.clear()
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
