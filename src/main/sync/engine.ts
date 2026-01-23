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
import { getDatabase } from '../database/client'
import { syncState, syncHistory, devices } from '@shared/db/schema/sync-schema'
import { getSyncQueue, type QueueItem } from './queue'
import { getNetworkMonitor } from './network'
import { getWebSocketManager, type WebSocketMessage } from './websocket'
import { withRetry, isRetryableError } from './retry'
import { getSyncApiClient, SyncApiError } from './api-client'
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
  VectorClock
} from '@shared/contracts/sync-api'
import type { SyncStatusChangedEvent } from '@shared/contracts/ipc-sync'

export interface SyncEngineEvents extends Record<string, unknown[]> {
  'sync:status-changed': [event: SyncStatusChangedEvent]
  'sync:item-synced': [itemId: string, direction: 'push' | 'pull']
  'sync:error': [error: Error, context: string]
  'sync:push-complete': [accepted: string[], rejected: string[]]
  'sync:pull-complete': [items: SyncItemResponse[]]
  'sync:session-expired': []
}

const MAX_BATCH_SIZE = 100

export interface EncryptedSyncItem {
  itemType: SyncItemType
  itemId: string
  encryptedData: string
  encryptedKey: string
  keyNonce: string
  dataNonce: string
  clock?: VectorClock
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
  stateVector?: string
  deleted: boolean
  signerDeviceId: string
  serverCursor: number
  createdAt: number
  updatedAt: number
}

const SYNC_STATE_KEYS = {
  CURSOR: 'server_cursor',
  STATUS: 'sync_status',
  LAST_SYNC: 'last_sync_at',
  DEVICE_CLOCK: 'device_clock'
} as const

export class SyncEngine extends TypedEmitter<SyncEngineEvents> {
  private _status: SyncStatus = 'idle'
  private initialized = false
  private syncLock = false
  private onlineHandler = (): void => this.handleOnline()
  private offlineHandler = (): void => this.handleOffline()
  private messageHandler = (message: WebSocketMessage): void => {
    if (message.type === 'sync') this.handleSyncNotification()
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const networkMonitor = getNetworkMonitor()
    networkMonitor.on('sync:online', this.onlineHandler)
    networkMonitor.on('sync:offline', this.offlineHandler)

    const wsManager = getWebSocketManager()
    if (wsManager) {
      wsManager.on('sync:ws-message', this.messageHandler)
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
    }

    this.initialized = false
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
  }

  /**
   * Push pending items from the queue to the server.
   * Items are encrypted, signed, and sent in batches of MAX_BATCH_SIZE.
   *
   * @returns Push response from server or null if skipped
   */
  async push(): Promise<PushSyncResponse | null> {
    if (this.syncLock) return null
    if (!getNetworkMonitor().isOnline()) {
      this.setStatus('offline')
      return null
    }

    const queue = getSyncQueue()
    if (queue.isEmpty()) return null

    this.syncLock = true
    this.setStatus('syncing')

    try {
      const allItems = queue.getAll()
      const itemBatches = this.chunkArray(allItems, MAX_BATCH_SIZE)
      let lastResponse: PushSyncResponse | null = null

      for (const items of itemBatches) {
        const encryptedItems: SyncItemPush[] = []

        for (const queueItem of items) {
          try {
            const encrypted = await this.encryptAndSignItem(queueItem)
            encryptedItems.push(encrypted)
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            await queue.updateAttempt(queueItem.id, err.message)
            this.emit('sync:error', err, `encrypt item ${queueItem.itemId}`)
          }
        }

        if (encryptedItems.length === 0) continue

        const deviceClock = await this.getDeviceClock()
        const apiClient = getSyncApiClient()

        try {
          const response = await withRetry(() => apiClient.pushItems(encryptedItems, deviceClock), {
            shouldRetry: (error) => this.shouldRetryWithAuthCheck(error),
            onRetry: (error, attempt) => {
              this.emit('sync:error', error, `push retry ${attempt}`)
            }
          })

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

          await this.updateCursor(response.serverCursor)
          lastResponse = response
        } catch (error) {
          if (this.isAuthError(error)) {
            this.emit('sync:session-expired')
            this.broadcastToWindows('sync:session-expired', undefined)
            throw error
          }
          throw error
        }
      }

      if (lastResponse) {
        await this.logSyncHistory('push', allItems.length, 'upload')
        this.emit(
          'sync:push-complete',
          lastResponse.accepted,
          lastResponse.rejected.map((r) => r.itemId)
        )
      }
      this.setStatus('idle')

      return lastResponse
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('sync:error', err, 'push')
      await this.logSyncHistory('error', 0, null, err.message)
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
    if (this.syncLock) return null
    if (!getNetworkMonitor().isOnline()) {
      this.setStatus('offline')
      return null
    }

    this.syncLock = true
    this.setStatus('syncing')

    try {
      const cursor = await this.getCursor()
      const apiClient = getSyncApiClient()

      let response: PullSyncResponse
      try {
        response = await withRetry(() => apiClient.pullItems(cursor), {
          shouldRetry: (error) => this.shouldRetryWithAuthCheck(error),
          onRetry: (error, attempt) => {
            this.emit('sync:error', error, `pull retry ${attempt}`)
          }
        })
      } catch (error) {
        if (this.isAuthError(error)) {
          this.emit('sync:session-expired')
          this.broadcastToWindows('sync:session-expired', undefined)
          throw error
        }
        throw error
      }

      const decryptedItems: DecryptedSyncItem[] = []

      for (const item of response.items) {
        try {
          const decrypted = await this.verifyAndDecryptItem(item)
          decryptedItems.push(decrypted)
          this.emit('sync:item-synced', item.itemId, 'pull')
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          this.emit('sync:error', err, `decrypt item ${item.itemId}`)
        }
      }

      await this.updateCursor(response.nextCursor)
      await this.logSyncHistory('pull', response.items.length, 'download')

      this.emit('sync:pull-complete', response.items)
      this.setStatus('idle')

      return response
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('sync:error', err, 'pull')
      await this.logSyncHistory('error', 0, null, err.message)
      this.setStatus('error')
      return null
    } finally {
      this.syncLock = false
    }
  }

  /**
   * Perform a full sync cycle: push then pull.
   */
  async sync(): Promise<void> {
    await this.push()
    await this.pull()
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
   * @param options - Additional options (operation, clock, stateVector, deleted)
   * @returns Encrypted and signed sync item
   */
  async encryptItem(
    itemType: SyncItemType,
    itemId: string,
    data: unknown,
    options: {
      operation?: 'create' | 'update' | 'delete'
      clock?: VectorClock
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
        operation: options.operation,
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey,
        keyNonce,
        encryptedData,
        dataNonce,
        metadata: {
          clock: options.clock,
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
    const data = JSON.parse(queueItem.payload)

    const encrypted = await this.encryptItem(queueItem.type, queueItem.itemId, data, {
      operation: queueItem.operation as 'create' | 'update' | 'delete'
    })

    return encrypted
  }

  private async verifyAndDecryptItem(item: SyncItemResponse): Promise<DecryptedSyncItem> {
    const signerPublicKey = await this.getDevicePublicKey(item.signerDeviceId)

    if (!signerPublicKey) {
      throw new Error(`Unknown signer device: ${item.signerDeviceId}`)
    }

    return this.decryptItem(item, signerPublicKey)
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

  private handleOffline(): void {
    this.setStatus('offline')
  }

  private handleSyncNotification(): void {
    if (this._status === 'idle') {
      this.pull().catch((err) =>
        this.emit(
          'sync:error',
          err instanceof Error ? err : new Error(String(err)),
          'handleSyncNotification'
        )
      )
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
