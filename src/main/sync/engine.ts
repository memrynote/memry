/**
 * Sync Engine
 *
 * Core synchronization engine that orchestrates the sync process.
 * Handles encryption/decryption, push/pull operations, and state management.
 *
 * @module sync/engine
 */

import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import { TypedEmitter } from './typed-emitter'
import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase, getIndexDatabase } from '../database/client'
import { getSetting, setSetting } from '@shared/db/queries/settings'
import { getNoteCacheById } from '@shared/db/queries/notes'
import { syncState, syncHistory, devices } from '@shared/db/schema/sync-schema'
import { getSyncQueue, type QueueItem } from './queue'
import { getNetworkMonitor } from './network'
import { getWebSocketManager, type WebSocketMessage } from './websocket'
import { withRetry, isRetryableError } from './retry'
import { getSyncApiClient, SyncApiError } from './api-client'
import { refreshAccessToken } from './token-refresh'
import { compareClock, mergeClock, emptyClock } from './vector-clock'
import { isSyncAuthReady } from './auth-state'
import { getCrdtSyncBridge } from './crdt-sync-bridge'
import { fetchAndStoreAccountDevices } from '../ipc/sync-handlers'
import {
  generateFileKey,
  wrapFileKey,
  unwrapFileKey,
  encrypt,
  decrypt,
  uint8ArrayToBase64,
  base64ToUint8Array,
  retrieveKeyMaterial,
  retrieveDeviceKeyPair,
  deriveVaultKey,
  secureZero
} from '../crypto'
import { signPayloadBase64, verifyPayload } from '../crypto/signatures'
import { CRYPTO_VERSION } from '@shared/contracts/crypto'
import type { SignaturePayloadV1, CryptoVersion } from '@shared/contracts/crypto'
import type {
  SyncStatus,
  SyncItemType,
  SyncItemPush,
  SyncItemResponse,
  PushSyncResponse,
  PullSyncResponse,
  VectorClock,
  FieldClocks,
  SyncedSettingsPayload,
  SyncedSettingsPayloadSchema
} from '@shared/contracts/sync-api'
import type { SyncStatusChangedEvent } from '@shared/contracts/ipc-sync'

export interface SyncEngineEvents extends Record<string, unknown[]> {
  'sync:status-changed': [event: SyncStatusChangedEvent]
  'sync:item-synced': [itemId: string, direction: 'push' | 'pull']
  'sync:item-decrypted': [item: DecryptedSyncItem]
  'sync:conflict-detected': [event: SyncConflictEvent]
  'sync:error': [error: Error, context: string]
  'sync:push-complete': [accepted: string[], rejected: string[]]
  'sync:pull-start': [{ totalItems: number }]
  'sync:pull-complete': [{ totalItems: number }]
  'sync:session-expired': []
}

const MAX_BATCH_SIZE = 100
const LOG_PREFIX = '[SyncEngine]'

export interface EncryptedSyncItem {
  itemType: SyncItemType
  itemId: string
  encryptedData: string
  encryptedKey: string
  keyNonce: string
  dataNonce: string
  clock?: VectorClock
  fieldClocks?: FieldClocks
  stateVector?: string
  deleted: boolean
  cryptoVersion: CryptoVersion
  sizeBytes: number
  contentHash: string
  signerDeviceId: string
  signature: string
}

export interface DecryptedSyncItem {
  itemType: SyncItemType
  itemId: string
  data: unknown
  clock?: VectorClock
  fieldClocks?: FieldClocks
  stateVector?: string
  deleted: boolean
  signerDeviceId: string
  serverCursor: number
  createdAt: number
  updatedAt: number
}

export interface SyncConflictEvent {
  itemId: string
  itemType: SyncItemType
  field: string
  localClock: VectorClock
  remoteClock: VectorClock
  localValue: unknown
  remoteValue: unknown
}

const SYNC_STATE_KEYS = {
  CURSOR: 'server_cursor',
  STATUS: 'sync_status',
  LAST_SYNC: 'last_sync_at',
  DEVICE_CLOCK: 'device_clock',
  SETTINGS_FIELD_CLOCKS: 'settings_field_clocks'
} as const

const SYNC_SETTINGS_KEY = 'sync.settings'

export class SyncEngine extends TypedEmitter<SyncEngineEvents> {
  private _status: SyncStatus = 'idle'
  private pendingSyncNotification = false
  private initialized = false
  private syncLock = false
  private deviceRefreshInProgress = false
  private lastDeviceRefresh = 0
  private recentlyPushedNoteIds: Set<string> = new Set()
  private lastPushTimestamp = 0
  private itemProcessor: ((item: DecryptedSyncItem) => Promise<void>) | null = null
  private onlineHandler = (): void => this.handleOnline()
  private offlineHandler = (): void => this.handleOffline()
  private messageHandler = (message: WebSocketMessage): void => {
    console.info('[SyncEngine] WebSocket message received:', {
      type: message.type,
      noteIds: (message as { noteIds?: string[] }).noteIds
    })
    if (message.type === 'sync' || message.type === 'changes') {
      this.handleSyncNotification()
    } else if (message.type === 'crdt' && message.noteIds) {
      this.handleCrdtNotification(message.noteIds)
    }
  }
  private wsConnectedHandler = (): void => this.handleWsConnected()

  async initialize(): Promise<void> {
    if (this.initialized) return

    const networkMonitor = getNetworkMonitor()
    networkMonitor.on('sync:online', this.onlineHandler)
    networkMonitor.on('sync:offline', this.offlineHandler)

    const wsManager = getWebSocketManager()
    if (wsManager) {
      wsManager.on('sync:ws-message', this.messageHandler)
      wsManager.on('sync:ws-connected', this.wsConnectedHandler)
    }

    await this.loadStatus()
    this.initialized = true
  }

  shutdown(): void {
    const networkMonitor = getNetworkMonitor()
    networkMonitor.off('sync:online', this.onlineHandler)
    networkMonitor.off('sync:offline', this.offlineHandler)

    const wsManager = getWebSocketManager()
    if (wsManager) {
      wsManager.off('sync:ws-message', this.messageHandler)
      wsManager.off('sync:ws-connected', this.wsConnectedHandler)
    }

    this.itemProcessor = null
    this.initialized = false
  }

  registerItemProcessor(processor: (item: DecryptedSyncItem) => Promise<void>): void {
    this.itemProcessor = processor
  }

  get status(): SyncStatus {
    return this._status
  }

  private setStatus(status: SyncStatus): void {
    if (this._status !== status) {
      const previousStatus = this._status
      this._status = status
      const event: SyncStatusChangedEvent = {
        previousStatus,
        currentStatus: status,
        timestamp: Date.now()
      }
      this.emit('sync:status-changed', event)
      this.broadcastToWindows('sync:status-changed', event)
      this.persistStatus(status)
    }
    if (status === 'idle' && this.pendingSyncNotification) {
      this.pendingSyncNotification = false
      this.handleSyncNotification()
    }
  }

  /**
   * Push pending items from the queue to the server.
   * Items are encrypted, signed, and sent in batches of MAX_BATCH_SIZE.
   *
   * @returns Push response from server or null if skipped
   */
  async push(): Promise<PushSyncResponse | null> {
    if (!isSyncAuthReady()) {
      console.debug(`${LOG_PREFIX} Push skipped: not authenticated`)
      return null
    }
    if (this.syncLock) {
      console.info(`${LOG_PREFIX} Push skipped: sync already in progress`)
      return null
    }
    if (!getNetworkMonitor().isOnline()) {
      this.setStatus('offline')
      console.info(`${LOG_PREFIX} Push skipped: offline`)
      return null
    }

    const queue = getSyncQueue()
    if (queue.isEmpty()) {
      console.info(`${LOG_PREFIX} Push skipped: queue empty`)
      return null
    }

    this.syncLock = true
    this.setStatus('syncing')

    try {
      const allItems = queue.getAll()
      const itemBatches = this.chunkArray(allItems, MAX_BATCH_SIZE)
      console.info(`${LOG_PREFIX} Push starting`, {
        itemCount: allItems.length,
        batchCount: itemBatches.length
      })
      let lastResponse: PushSyncResponse | null = null
      const accepted: string[] = []
      const rejected: Array<{ itemId: string; reason: string }> = []
      const batchErrors: Error[] = []

      for (const [batchIndex, items] of itemBatches.entries()) {
        console.info(`${LOG_PREFIX} Push batch`, {
          batch: batchIndex + 1,
          batchCount: itemBatches.length,
          itemCount: items.length
        })
        const encryptedItems: SyncItemPush[] = []

        for (const queueItem of items) {
          try {
            const encrypted = await this.encryptAndSignItem(queueItem)
            encryptedItems.push(encrypted)
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            await queue.updateAttempt(queueItem.id, err.message)
            this.emit('sync:error', err, `encrypt item ${queueItem.itemId}`)
            console.warn(`${LOG_PREFIX} Failed to encrypt item`, {
              itemId: queueItem.itemId,
              itemType: queueItem.type,
              error: err.message
            })
          }
        }

        if (encryptedItems.length === 0) continue

        const deviceClock = await this.getDeviceClock()
        const apiClient = getSyncApiClient()

        try {
          const response = await withRetry(
            () => this.withAuthRefresh(() => apiClient.pushItems(encryptedItems, deviceClock)),
            {
              shouldRetry: (error) => this.shouldRetryWithAuthCheck(error),
              onRetry: (error, attempt) => {
                this.emit('sync:error', error, `push retry ${attempt}`)
              }
            }
          )

          console.info(`${LOG_PREFIX} Push batch result`, {
            accepted: response.accepted.length,
            rejected: response.rejected.length,
            conflicts: response.conflicts.length,
            serverCursor: response.serverCursor
          })
          if (response.rejected.length > 0) {
            console.warn(`${LOG_PREFIX} Push rejected items`, response.rejected)
          }
          if (response.conflicts.length > 0) {
            console.warn(`${LOG_PREFIX} Push conflicts`, {
              conflictCount: response.conflicts.length
            })
          }

          accepted.push(...response.accepted)
          rejected.push(...response.rejected)

          for (const itemId of response.accepted) {
            const queueItem = items.find((i) => i.itemId === itemId)
            if (queueItem) {
              await queue.remove(queueItem.id)
              this.emit('sync:item-synced', itemId, 'push')
            }
          }

          for (const { itemId, reason } of response.rejected) {
            const queueItem = items.find((i) => i.itemId === itemId)
            if (queueItem) {
              await queue.updateAttempt(queueItem.id, reason)
            }
          }

          lastResponse = response
        } catch (error) {
          if (this.isAuthError(error)) {
            this.emit('sync:session-expired')
            this.broadcastToWindows('sync:session-expired', undefined)
            throw error
          }
          const err = error instanceof Error ? error : new Error(String(error))
          batchErrors.push(err)
          this.emit('sync:error', err, 'push batch failed')
          console.warn(`${LOG_PREFIX} Push batch failed`, err)
          continue
        }
      }

      if (lastResponse) {
        await this.logSyncHistory('push', allItems.length, 'upload')
        this.emit(
          'sync:push-complete',
          accepted,
          rejected.map((r) => r.itemId)
        )
        console.info(`${LOG_PREFIX} Push complete`, {
          accepted: accepted.length,
          rejected: rejected.length,
          total: allItems.length
        })
        this.lastPushTimestamp = Date.now()

        const currentCursor = await this.getCursor()
        if (lastResponse.serverCursor > currentCursor) {
          await this.updateCursor(lastResponse.serverCursor)
        }

        for (const itemId of accepted) {
          this.recentlyPushedNoteIds.add(itemId)
          setTimeout(() => this.recentlyPushedNoteIds.delete(itemId), 5000)
        }
      } else if (batchErrors.length > 0) {
        await this.logSyncHistory('error', 0, null, batchErrors[0]?.message)
        this.setStatus('error')
        return null
      }
      this.setStatus('idle')

      return lastResponse
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('sync:error', err, 'push')
      await this.logSyncHistory('error', 0, null, err.message)
      console.warn(`${LOG_PREFIX} Push failed`, err)
      this.setStatus('error')
      return null
    } finally {
      this.syncLock = false
    }
  }

  /**
   * Pull items from the server since the last cursor position.
   * Items are verified, decrypted, and events are emitted for each.
   *
   * @returns Pull response from server or null if skipped
   */
  async pull(): Promise<PullSyncResponse | null> {
    if (!isSyncAuthReady()) {
      console.debug(`${LOG_PREFIX} Pull skipped: not authenticated`)
      return null
    }
    if (this.syncLock) {
      console.info(`${LOG_PREFIX} Pull skipped: sync already in progress`)
      return null
    }
    if (!getNetworkMonitor().isOnline()) {
      this.setStatus('offline')
      console.info(`${LOG_PREFIX} Pull skipped: offline`)
      return null
    }

    this.syncLock = true
    this.setStatus('syncing')

    try {
      const apiClient = getSyncApiClient()
      let cursor = await this.getCursor()
      console.info(`${LOG_PREFIX} Pull starting`, { cursor })
      let hasMore = true
      let lastResponse: PullSyncResponse | null = null
      let totalItems = 0

      while (hasMore) {
        let response: PullSyncResponse
        try {
          response = await withRetry(
            () => this.withAuthRefresh(() => apiClient.pullItems(cursor, MAX_BATCH_SIZE)),
            {
              shouldRetry: (error) => this.shouldRetryWithAuthCheck(error),
              onRetry: (error, attempt) => {
                this.emit('sync:error', error, `pull retry ${attempt}`)
              }
            }
          )
        } catch (error) {
          if (this.isAuthError(error)) {
            this.emit('sync:session-expired')
            this.broadcastToWindows('sync:session-expired', undefined)
            throw error
          }
          throw error
        }

        this.checkServerClockSkew(response.serverTime)
        console.info(`${LOG_PREFIX} Pull batch`, {
          itemCount: response.items.length,
          hasMore: response.hasMore,
          nextCursor: response.nextCursor
        })

        if (response.items.length > 0) {
          this.emit('sync:pull-start', { totalItems: response.items.length })
        }

        for (const item of response.items) {
          try {
            const decrypted = await this.verifyAndDecryptItem(item)
            if (this.itemProcessor) {
              await this.itemProcessor(decrypted)
            }
            this.emit('sync:item-decrypted', decrypted)
            await this.applySettingsSync(decrypted)
            this.emit('sync:item-synced', item.itemId, 'pull')
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            this.emit('sync:error', err, `process item ${item.itemId}`)
            console.warn(`${LOG_PREFIX} Failed to process item`, {
              itemId: item.itemId,
              itemType: item.itemType,
              error: err.message
            })
          }
        }

        totalItems += response.items.length
        cursor = response.nextCursor
        hasMore = response.hasMore
        lastResponse = response

        if (response.items.length === 0 && !response.hasMore) {
          break
        }
      }

      if (lastResponse) {
        await this.updateCursor(lastResponse.nextCursor)
        await this.logSyncHistory('pull', totalItems, 'download')
        this.emit('sync:pull-complete', { totalItems })
        console.info(`${LOG_PREFIX} Pull complete`, { itemCount: totalItems })
      }

      this.setStatus('idle')

      return lastResponse
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('sync:error', err, 'pull')
      await this.logSyncHistory('error', 0, null, err.message)
      console.warn(`${LOG_PREFIX} Pull failed`, err)
      this.setStatus('error')
      return null
    } finally {
      this.syncLock = false
    }
  }

  /**
   * Perform a full sync cycle: push then pull.
   */
  async sync(options?: { skipPull?: boolean }): Promise<{ pushed: boolean; pulled: boolean }> {
    const pushResult = await this.push()
    const pushed = pushResult !== null

    let pulled = false
    if (!options?.skipPull) {
      const pullResult = await this.pull()
      pulled = pullResult !== null
    }

    return { pushed, pulled }
  }

  /**
   * Pause sync operations.
   */
  pause(): void {
    this.setStatus('paused')
  }

  /**
   * Resume sync operations from paused state.
   */
  resume(): void {
    if (this._status === 'paused') {
      this.setStatus('idle')
    }
  }

  /**
   * Check if sync is currently in progress.
   */
  get isSyncing(): boolean {
    return this.syncLock
  }

  /**
   * Get the current server cursor position.
   */
  async getServerCursor(): Promise<number> {
    return this.getCursor()
  }

  /**
   * Get the timestamp of the last successful sync.
   */
  async getLastSyncAt(): Promise<number | undefined> {
    const db = getDatabase()
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.LAST_SYNC))
      .limit(1)

    return row[0] ? parseInt(row[0].value, 10) : undefined
  }

  /**
   * Get the current device clock for vector clock synchronization.
   */
  async getDeviceClockPublic(): Promise<VectorClock> {
    return this.getDeviceClock()
  }

  /**
   * Encrypt and sign an item for sync.
   *
   * @param itemType - The type of sync item
   * @param itemId - The unique identifier of the item
   * @param data - The plaintext data to encrypt
   * @param options - Additional options (clock, stateVector, deleted)
   * @returns Encrypted and signed sync item
   */
  async encryptItem(
    itemType: SyncItemType,
    itemId: string,
    data: unknown,
    options: {
      clock?: VectorClock
      fieldClocks?: FieldClocks
      stateVector?: string
      deleted?: boolean
    } = {}
  ): Promise<EncryptedSyncItem> {
    const vaultKey = await this.getVaultKey()
    const deviceKeyPair = await retrieveDeviceKeyPair()

    if (!deviceKeyPair) {
      throw new Error('Device key pair not found')
    }

    const fileKey = await generateFileKey()
    try {
      const { encryptedKey, keyNonce } = await wrapFileKey(fileKey, vaultKey)

      const jsonData = JSON.stringify(data)
      const plaintext = new TextEncoder().encode(jsonData)
      const { ciphertext, nonce } = await encrypt(plaintext, fileKey)

      const encryptedData = uint8ArrayToBase64(ciphertext)
      const dataNonce = uint8ArrayToBase64(nonce)

      const contentHash = this.computeContentHash(ciphertext, encryptedKey, keyNonce, dataNonce)
      const sizeBytes = ciphertext.length

      const signaturePayload: SignaturePayloadV1 = {
        id: itemId,
        type: itemType,
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey,
        keyNonce,
        encryptedData,
        dataNonce,
        metadata: {
          clock: options.clock,
          fieldClocks: options.fieldClocks,
          stateVector: options.stateVector
        }
      }

      const signature = await signPayloadBase64(
        signaturePayload,
        deviceKeyPair.privateKey,
        deviceKeyPair.deviceId
      )

      return {
        itemType,
        itemId,
        encryptedData,
        encryptedKey,
        keyNonce,
        dataNonce,
        clock: options.clock,
        fieldClocks: options.fieldClocks,
        stateVector: options.stateVector,
        deleted: options.deleted ?? false,
        cryptoVersion: CRYPTO_VERSION,
        sizeBytes,
        contentHash,
        signerDeviceId: deviceKeyPair.deviceId,
        signature
      }
    } finally {
      await secureZero(fileKey)
    }
  }

  /**
   * Re-sign an already encrypted item with this device's key.
   *
   * @param encryptedItem - The encrypted item to sign
   * @returns The item with updated signature and signerDeviceId
   */
  async signItem(encryptedItem: EncryptedSyncItem): Promise<EncryptedSyncItem> {
    const deviceKeyPair = await retrieveDeviceKeyPair()

    if (!deviceKeyPair) {
      throw new Error('Device key pair not found')
    }

    const signaturePayload: SignaturePayloadV1 = {
      id: encryptedItem.itemId,
      type: encryptedItem.itemType,
      cryptoVersion: encryptedItem.cryptoVersion,
      encryptedKey: encryptedItem.encryptedKey,
      keyNonce: encryptedItem.keyNonce,
      encryptedData: encryptedItem.encryptedData,
      dataNonce: encryptedItem.dataNonce,
      metadata: {
        clock: encryptedItem.clock,
        fieldClocks: encryptedItem.fieldClocks,
        stateVector: encryptedItem.stateVector
      }
    }

    const signature = await signPayloadBase64(
      signaturePayload,
      deviceKeyPair.privateKey,
      deviceKeyPair.deviceId
    )

    return {
      ...encryptedItem,
      signerDeviceId: deviceKeyPair.deviceId,
      signature
    }
  }

  /**
   * Verify signature and decrypt an item received from the server.
   *
   * @param item - The encrypted item from the server
   * @param signerPublicKey - The public key of the signing device
   * @returns Decrypted item with metadata
   * @throws Error if signature verification fails
   */
  async decryptItem(item: SyncItemResponse, signerPublicKey: string): Promise<DecryptedSyncItem> {
    const signaturePayload: SignaturePayloadV1 = {
      id: item.itemId,
      type: item.itemType,
      cryptoVersion: item.cryptoVersion as CryptoVersion,
      encryptedKey: item.encryptedKey,
      keyNonce: item.keyNonce,
      encryptedData: item.encryptedData,
      dataNonce: item.dataNonce,
      metadata: {
        clock: item.clock,
        fieldClocks: item.fieldClocks,
        stateVector: item.stateVector
      }
    }

    const verificationResult = await verifyPayload(
      signaturePayload,
      item.signature,
      signerPublicKey
    )

    if (!verificationResult.valid) {
      throw new Error(`Signature verification failed: ${verificationResult.error}`)
    }

    const vaultKey = await this.getVaultKey()
    const fileKey = await unwrapFileKey(item.encryptedKey, item.keyNonce, vaultKey)
    try {
      const ciphertext = base64ToUint8Array(item.encryptedData)
      const nonce = base64ToUint8Array(item.dataNonce)
      const plaintext = await decrypt(ciphertext, nonce, fileKey)

      const jsonData = new TextDecoder().decode(plaintext)
      const data = JSON.parse(jsonData)

      return {
        itemType: item.itemType,
        itemId: item.itemId,
        data,
        clock: item.clock,
        fieldClocks: item.fieldClocks,
        stateVector: item.stateVector,
        deleted: item.deleted,
        signerDeviceId: item.signerDeviceId,
        serverCursor: item.serverCursor,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }
    } finally {
      await secureZero(fileKey)
    }
  }

  private async encryptAndSignItem(queueItem: QueueItem): Promise<SyncItemPush> {
    const rawData = JSON.parse(queueItem.payload)
    let data = rawData as unknown
    let clock: VectorClock | undefined
    let fieldClocks: FieldClocks | undefined

    if (rawData && typeof rawData === 'object') {
      const maybeClock = (rawData as { clock?: VectorClock | string | null }).clock
      if (typeof maybeClock === 'string') {
        try {
          clock = JSON.parse(maybeClock) as VectorClock
        } catch {
          clock = undefined
        }
      } else if (maybeClock && typeof maybeClock === 'object') {
        clock = maybeClock
      }

      const maybeFieldClocks = (rawData as { fieldClocks?: FieldClocks | string | null })
        .fieldClocks
      if (typeof maybeFieldClocks === 'string') {
        try {
          fieldClocks = JSON.parse(maybeFieldClocks) as FieldClocks
        } catch {
          fieldClocks = undefined
        }
      } else if (maybeFieldClocks && typeof maybeFieldClocks === 'object') {
        fieldClocks = maybeFieldClocks
      }
    }

    if (queueItem.type === 'settings') {
      const parsed = SyncedSettingsPayloadSchema.safeParse(rawData)
      if (parsed.success) {
        data = parsed.data
        fieldClocks = undefined
      }
    }

    const encrypted = await this.encryptItem(queueItem.type, queueItem.itemId, data, {
      clock: clock ?? emptyClock(),
      fieldClocks
    })

    return encrypted
  }


  private async refreshDeviceList(): Promise<void> {
    const now = Date.now()
    if (this.deviceRefreshInProgress || now - this.lastDeviceRefresh < 30_000) {
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

  private async verifyAndDecryptItem(item: SyncItemResponse): Promise<DecryptedSyncItem> {
    let signerPublicKey = await this.getDevicePublicKey(item.signerDeviceId)

    if (!signerPublicKey) {
      await this.refreshDeviceList()
      signerPublicKey = await this.getDevicePublicKey(item.signerDeviceId)
    }

    if (!signerPublicKey) {
      throw new Error(`Unknown signer device: ${item.signerDeviceId}`)
    }

    return this.decryptItem(item, signerPublicKey)
  }

  private async applySettingsSync(item: DecryptedSyncItem): Promise<void> {
    if (item.itemType !== 'settings') {
      return
    }

    const parsed = SyncedSettingsPayloadSchema.safeParse(item.data)
    if (!parsed.success) {
      console.warn('[SyncEngine] Ignoring invalid settings payload:', parsed.error)
      return
    }

    const { settings: remoteSettings, fieldClocks: remoteFieldClocks } = parsed.data
    const db = getDatabase()
    const localSettingsRaw = getSetting(db, SYNC_SETTINGS_KEY)
    let localSettings: SyncedSettingsPayload['settings'] | null = null
    if (localSettingsRaw) {
      try {
        localSettings = JSON.parse(localSettingsRaw) as SyncedSettingsPayload['settings']
      } catch (error) {
        console.warn('[SyncEngine] Failed to parse local synced settings:', error)
      }
    }
    const localFieldClocks = await this.getSettingsFieldClocks()

    if (!localSettings) {
      setSetting(db, SYNC_SETTINGS_KEY, JSON.stringify(remoteSettings))
      await this.setSettingsFieldClocks(remoteFieldClocks)
      return
    }

    const fields = [
      'general.defaultView',
      'general.weekStartsOn',
      'general.dateFormat',
      'general.timeFormat',
      'general.language',
      'tasks.defaultProject',
      'tasks.defaultPriority',
      'tasks.autoArchiveCompleted',
      'tasks.archiveAfterDays',
      'notes.defaultFolder',
      'notes.autoSaveInterval',
      'notes.spellCheck',
      'sync.autoSync',
      'sync.syncOnStartup',
      'sync.conflictResolution'
    ]

    let changed = false
    for (const field of fields) {
      const remoteClock = remoteFieldClocks[field] ?? {}
      const localClock = localFieldClocks[field] ?? {}
      const comparison = compareClock(remoteClock, localClock)

      if (comparison === 1) {
        const remoteValue = this.getNestedValue(remoteSettings, field)
        this.setNestedValue(localSettings, field, remoteValue)
        localFieldClocks[field] = remoteClock
        changed = true
      } else if (comparison === 0) {
        const localValue = this.getNestedValue(localSettings, field)
        const remoteValue = this.getNestedValue(remoteSettings, field)

        const conflictEvent: SyncConflictEvent = {
          itemId: item.itemId,
          itemType: item.itemType,
          field,
          localClock,
          remoteClock,
          localValue,
          remoteValue
        }

        this.emit('sync:conflict-detected', conflictEvent)
        this.broadcastToWindows('sync:conflict-detected', conflictEvent)

        localFieldClocks[field] = mergeClock(localClock, remoteClock)
      }
    }

    if (changed) {
      setSetting(db, SYNC_SETTINGS_KEY, JSON.stringify(localSettings))
    }

    await this.setSettingsFieldClocks(localFieldClocks)
  }

  private getNestedValue(settings: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.')
    let current: Record<string, unknown> | undefined = settings
    for (const part of parts) {
      if (!current || typeof current !== 'object') {
        return undefined
      }
      current = current[part] as Record<string, unknown> | undefined
    }
    return current
  }

  private setNestedValue(settings: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.')
    let current: Record<string, unknown> = settings

    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {}
      }
      current = current[part] as Record<string, unknown>
    }

    current[parts[parts.length - 1] ?? ''] = value
  }

  private async getVaultKey(): Promise<Uint8Array> {
    const keyMaterial = await retrieveKeyMaterial()

    if (!keyMaterial) {
      throw new Error('Key material not found')
    }

    const masterKey = base64ToUint8Array(keyMaterial.masterKey)
    return deriveVaultKey(masterKey)
  }

  private async getDevicePublicKey(deviceId: string): Promise<string | null> {
    const deviceKeyPair = await retrieveDeviceKeyPair()

    if (deviceKeyPair?.deviceId === deviceId) {
      return uint8ArrayToBase64(deviceKeyPair.publicKey)
    }

    const db = getDatabase()
    const rows = await db
      .select({ authPublicKey: devices.authPublicKey })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)

    return rows[0]?.authPublicKey ?? null
  }

  private async getCursor(): Promise<number> {
    const db = getDatabase()
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.CURSOR))
      .limit(1)

    return row[0] ? parseInt(row[0].value, 10) : 0
  }

  private async updateCursor(cursor: number): Promise<void> {
    const db = getDatabase()
    await db
      .insert(syncState)
      .values({
        key: SYNC_STATE_KEYS.CURSOR,
        value: cursor.toString(),
        updatedAt: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: syncState.key,
        set: {
          value: cursor.toString(),
          updatedAt: new Date().toISOString()
        }
      })
  }

  private checkServerClockSkew(serverTime?: number): void {
    if (!serverTime) return
    const skewMs = Math.abs(Date.now() - serverTime)
    if (skewMs > 5 * 60 * 1000) {
      console.warn(
        `[SyncEngine] Server clock skew detected: ${Math.round(skewMs / 1000)}s difference`
      )
    }
  }

  private async getSettingsFieldClocks(): Promise<FieldClocks> {
    const db = getDatabase()
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.SETTINGS_FIELD_CLOCKS))
      .limit(1)

    if (row[0]) {
      return JSON.parse(row[0].value) as FieldClocks
    }

    return {}
  }

  private async setSettingsFieldClocks(fieldClocks: FieldClocks): Promise<void> {
    const db = getDatabase()
    const now = new Date().toISOString()
    await db
      .insert(syncState)
      .values({
        key: SYNC_STATE_KEYS.SETTINGS_FIELD_CLOCKS,
        value: JSON.stringify(fieldClocks),
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: syncState.key,
        set: {
          value: JSON.stringify(fieldClocks),
          updatedAt: now
        }
      })
  }

  private async getDeviceClock(): Promise<VectorClock> {
    const db = getDatabase()
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.DEVICE_CLOCK))
      .limit(1)

    if (row[0]) {
      return JSON.parse(row[0].value) as VectorClock
    }

    return {}
  }

  private async loadStatus(): Promise<void> {
    const db = getDatabase()
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, SYNC_STATE_KEYS.STATUS))
      .limit(1)

    if (row[0]) {
      this._status = row[0].value as SyncStatus
    }
  }

  private async persistStatus(status: SyncStatus): Promise<void> {
    const db = getDatabase()
    await db
      .insert(syncState)
      .values({
        key: SYNC_STATE_KEYS.STATUS,
        value: status,
        updatedAt: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: syncState.key,
        set: {
          value: status,
          updatedAt: new Date().toISOString()
        }
      })
  }

  private async logSyncHistory(
    type: 'push' | 'pull' | 'error',
    itemCount: number,
    direction: 'upload' | 'download' | null,
    errorMessage?: string
  ): Promise<void> {
    const db = getDatabase()
    const now = new Date().toISOString()

    await db.insert(syncHistory).values({
      id: uuidv4(),
      type,
      itemCount,
      direction,
      details: errorMessage ? { error: errorMessage } : null,
      createdAt: now
    })

    if (type !== 'error') {
      await db
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.LAST_SYNC,
          value: Date.now().toString(),
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: syncState.key,
          set: {
            value: Date.now().toString(),
            updatedAt: now
          }
        })
      try {
        await this.updateDeviceLastSyncAt()
      } catch (error) {
        console.error('[SyncEngine] Failed to update device last sync timestamp:', error)
      }
    }
  }

  private async updateDeviceLastSyncAt(): Promise<void> {
    const db = getDatabase()
    const now = new Date().toISOString()
    await db.update(devices).set({ lastSyncAt: now }).where(eq(devices.isCurrentDevice, true))
  }

  private handleOnline(): void {
    if (this._status === 'offline') {
      this.setStatus('idle')
      this.sync().catch((err) =>
        this.emit('sync:error', err instanceof Error ? err : new Error(String(err)), 'handleOnline')
      )
    }
  }

  private handleWsConnected(): void {
    console.info('[SyncEngine] WebSocket connected, pulling metadata')
    this.pull().catch((err) => {
      console.error('[SyncEngine] Failed to pull after WS connect:', err)
    })
  }

  private handleOffline(): void {
    this.setStatus('offline')
  }

  private handleSyncNotification(): void {
    const timeSincePush = Date.now() - this.lastPushTimestamp
    if (timeSincePush < 2000) {
      return
    }
    if (this._status === 'idle') {
      this.pendingSyncNotification = false
      this.pull().catch((err) =>
        this.emit(
          'sync:error',
          err instanceof Error ? err : new Error(String(err)),
          'handleSyncNotification'
        )
      )
    } else {
      this.pendingSyncNotification = true
    }
  }

  private async handleCrdtNotification(noteIds: string[]): Promise<void> {
    console.info('[SyncEngine] handleCrdtNotification called:', { noteIds })
    const noteIdsToProcess = noteIds.filter((id) => !this.recentlyPushedNoteIds.has(id))
    if (noteIdsToProcess.length === 0) {
      return
    }
    const crdtBridge = getCrdtSyncBridge()
    if (!crdtBridge) {
      console.warn('[SyncEngine] CRDT bridge not available')
      return
    }

    const db = getIndexDatabase()

    const missingNoteIds = noteIdsToProcess.filter((noteId) => !getNoteCacheById(db, noteId))

    if (missingNoteIds.length > 0) {
      console.info('[SyncEngine] Missing notes detected, pulling metadata first:', missingNoteIds)

      try {
        await this.pull()
      } catch (err) {
        console.error('[SyncEngine] Metadata pull failed:', err)
      }

      const stillMissing = missingNoteIds.filter((noteId) => !getNoteCacheById(db, noteId))

      if (stillMissing.length > 0) {
        console.info('[SyncEngine] Notes still missing after pull, retrying in 500ms:', stillMissing)
        await new Promise((resolve) => setTimeout(resolve, 500))

        try {
          await this.pull()
        } catch (err) {
          console.error('[SyncEngine] Retry metadata pull failed:', err)
        }
      }
    }

    for (const noteId of noteIdsToProcess) {
      console.info('[SyncEngine] Pulling updates for note:', noteId)
      crdtBridge
        .pullUpdatesForNote(noteId)
        .then(() => {
          console.info('[SyncEngine] Successfully pulled updates for note:', noteId)
        })
        .catch((err) => {
          console.error('[SyncEngine] Failed to pull updates for note:', noteId, err)
          this.emit(
            'sync:error',
            err instanceof Error ? err : new Error(String(err)),
            'handleCrdtNotification'
          )
        })
    }
  }

  private broadcastToWindows(channel: string, data: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data)
      }
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize))
    }
    return chunks
  }

  private computeContentHash(
    ciphertext: Uint8Array,
    encryptedKey: string,
    keyNonce: string,
    dataNonce: string
  ): string {
    return createHash('sha256')
      .update(ciphertext)
      .update(encryptedKey)
      .update(keyNonce)
      .update(dataNonce)
      .digest('hex')
  }

  private isAuthError(error: unknown): boolean {
    if (error instanceof SyncApiError) {
      return error.status === 401 || error.status === 403
    }
    return false
  }

  private shouldRetryWithAuthCheck(error: Error): boolean {
    if (this.isAuthError(error)) {
      return false
    }
    return isRetryableError(error)
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

  private async tryRefreshSession(): Promise<boolean> {
    return refreshAccessToken()
  }
}

let syncEngineInstance: SyncEngine | null = null

export function getSyncEngine(): SyncEngine | null {
  return syncEngineInstance
}

export async function initSyncEngine(): Promise<SyncEngine> {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine()
    await syncEngineInstance.initialize()
  }
  return syncEngineInstance
}
