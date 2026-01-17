/**
 * Sync Engine
 *
 * Main orchestrator for sync operations. Handles:
 * - Push: Encrypt local changes and send to server
 * - Pull: Receive remote changes, verify, and decrypt
 * - Conflict detection and resolution (LWW for now)
 * - Queue processing with automatic retries
 *
 * @module main/sync/engine
 */

import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database/client'
import { syncState, syncHistory, SYNC_STATE_KEYS, type SyncQueueItem } from '@shared/db/schema/sync'
import { SYNC_EVENTS } from '@shared/contracts/ipc-sync'
import type {
  SyncState,
  SyncStatus,
  SyncPushItem,
  SyncPullItem,
  SyncPushResponse,
  SyncPullResponse,
  VectorClock,
  SyncItemType,
  SyncOperation
} from '@shared/contracts/sync-api'

import { getSyncQueue } from './queue'
import { getNetworkMonitor } from './network'
import { getWebSocketManager } from './websocket'
import { withRetry, isRetryableError } from './retry'
import {
  createClock,
  incrementClock,
  mergeClock,
  compareClock,
  ClockComparison,
  serializeClock,
  deserializeClock
} from './vector-clock'

import {
  encryptItemToBase64,
  decryptItemFromBase64,
  getMasterKey,
  deriveVaultKey,
  getDeviceId,
  getUserId,
  getTokens,
  signItem,
  verifyItem,
  deriveSigningKeySeed,
  generateSigningKeyPair
} from '../crypto'

// =============================================================================
// Types
// =============================================================================

/** Sync engine configuration */
export interface SyncEngineConfig {
  /** Batch size for push operations */
  pushBatchSize: number
  /** Batch size for pull operations */
  pullBatchSize: number
  /** Auto-sync interval in ms (0 = disabled) */
  autoSyncInterval: number
  /** Whether to sync on startup */
  syncOnStartup: boolean
}

/** Default configuration */
const DEFAULT_CONFIG: SyncEngineConfig = {
  pushBatchSize: 50,
  pullBatchSize: 100,
  autoSyncInterval: 0, // Disabled by default, use WebSocket
  syncOnStartup: true
}

/** Sync engine events */
export interface SyncEngineEvents {
  'status-changed': (status: SyncStatus) => void
  'item-synced': (item: {
    id: string
    type: SyncItemType
    operation: SyncOperation
    direction: 'push' | 'pull'
  }) => void
  error: (error: Error) => void
  'conflict-detected': (item: {
    id: string
    type: SyncItemType
    localClock: VectorClock
    remoteClock: VectorClock
  }) => void
}

/** Internal sync result */
interface SyncResult {
  pushed: number
  pulled: number
  conflicts: number
  errors: string[]
}

// =============================================================================
// Sync Engine Class
// =============================================================================

/**
 * Sync Engine
 *
 * Orchestrates all sync operations between local database and server.
 */
export class SyncEngine extends EventEmitter {
  private _config: SyncEngineConfig
  private _state: SyncState = 'initializing'
  private _isRunning: boolean = false
  private _isPaused: boolean = false
  private _syncInProgress: boolean = false
  private _lastSyncAt: number | null = null
  private _deviceClock: VectorClock = createClock()
  private _deviceId: string = ''
  private _userId: string = ''
  private _autoSyncTimer: NodeJS.Timeout | null = null

  constructor(config: Partial<SyncEngineConfig> = {}) {
    super()
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the sync engine.
   *
   * Loads state from database and sets up event listeners.
   */
  async initialize(): Promise<void> {
    // Load device and user IDs
    this._deviceId = (await getDeviceId()) ?? ''
    this._userId = (await getUserId()) ?? ''

    if (!this._deviceId || !this._userId) {
      this.setState('error')
      return
    }

    // Load persisted state
    await this.loadState()

    // Set up network monitor listeners
    const networkMonitor = getNetworkMonitor()
    networkMonitor.on('online', () => {
      if (this._state === 'offline') {
        this.setState('idle')
        // Trigger sync when coming back online
        this.sync().catch((err) => this.emit('error', err))
      }
    })
    networkMonitor.on('offline', () => {
      this.setState('offline')
    })

    // Set up WebSocket listeners
    const wsManager = getWebSocketManager()
    wsManager.on('item-synced', (wsPayload: { itemId: string; type: string }) => {
      // Another device pushed an item, pull it
      this.pullSingleItem(wsPayload.itemId, wsPayload.type as SyncItemType).catch((err) =>
        this.emit('error', err)
      )
    })

    // Set initial state based on network
    if (networkMonitor.isOffline) {
      this.setState('offline')
    } else {
      this.setState('idle')
    }
  }

  /**
   * Start the sync engine.
   *
   * Begins processing queue and connects WebSocket.
   */
  async start(): Promise<void> {
    if (this._isRunning) return
    this._isRunning = true

    // Connect WebSocket if we have credentials
    const tokens = await getTokens()
    if (tokens?.accessToken && this._userId && this._deviceId) {
      const serverUrl = process.env.SYNC_SERVER_URL || 'wss://api.memry.app'
      const wsUrl = serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws'
      getWebSocketManager().connect(wsUrl, this._userId, this._deviceId, tokens.accessToken)
    }

    // Start network monitor
    getNetworkMonitor().start()

    // Perform initial sync if configured
    if (this._config.syncOnStartup) {
      await this.sync()
    }

    // Start auto-sync timer if configured
    if (this._config.autoSyncInterval > 0) {
      this._autoSyncTimer = setInterval(() => {
        if (!this._isPaused) {
          this.sync().catch((err) => this.emit('error', err))
        }
      }, this._config.autoSyncInterval)
    }
  }

  /**
   * Stop the sync engine.
   *
   * Disconnects WebSocket and stops queue processing.
   */
  async stop(): Promise<void> {
    if (!this._isRunning) return
    this._isRunning = false

    // Stop auto-sync timer
    if (this._autoSyncTimer) {
      clearInterval(this._autoSyncTimer)
      this._autoSyncTimer = null
    }

    // Disconnect WebSocket
    getWebSocketManager().disconnect()

    // Stop network monitor
    getNetworkMonitor().stop()

    // Save state
    await this.saveState()

    this.setState('idle')
  }

  /**
   * Pause sync operations.
   */
  pause(): void {
    this._isPaused = true
  }

  /**
   * Resume sync operations.
   */
  resume(): void {
    this._isPaused = false
    // Trigger sync
    this.sync().catch((err) => this.emit('error', err))
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Perform a full sync cycle (push then pull).
   */
  async sync(): Promise<SyncResult> {
    if (this._syncInProgress || this._isPaused) {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: [] }
    }

    if (this._state === 'offline') {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: ['Device is offline'] }
    }

    this._syncInProgress = true
    this.setState('syncing')

    const startTime = Date.now()
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] }

    try {
      // Push local changes first
      const pushResult = await this.push()
      result.pushed = pushResult.pushed
      result.conflicts += pushResult.conflicts
      result.errors.push(...pushResult.errors)

      // Then pull remote changes
      const pullResult = await this.pull()
      result.pulled = pullResult.pulled
      result.conflicts += pullResult.conflicts
      result.errors.push(...pullResult.errors)

      // Update last sync time
      this._lastSyncAt = Date.now()
      await this.saveState()

      // Record history
      await this.recordHistory('push', result.pushed, 'upload', Date.now() - startTime)
      await this.recordHistory('pull', result.pulled, 'download', Date.now() - startTime)

      this.setState('idle')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result.errors.push(errorMessage)
      this.emit('error', error instanceof Error ? error : new Error(errorMessage))
      this.setState('error')
    } finally {
      this._syncInProgress = false
    }

    return result
  }

  /**
   * Push local changes to the server.
   */
  async push(): Promise<{ pushed: number; conflicts: number; errors: string[] }> {
    const queue = getSyncQueue()
    const result = { pushed: 0, conflicts: 0, errors: [] as string[] }

    // Reset stuck items first
    await queue.resetStuckItems()

    // Get items to push
    const items = await queue.getNextItems(this._config.pushBatchSize)
    if (items.length === 0) {
      return result
    }

    // Process items in batch
    const pushItems: SyncPushItem[] = []
    const processedIds: string[] = []

    for (const item of items) {
      try {
        // Mark as in progress
        await queue.markInProgress(item.id)

        // Encrypt and sign the item
        const encrypted = await this.encryptQueueItem(item)
        if (encrypted) {
          pushItems.push(encrypted)
          processedIds.push(item.id)
        } else {
          // Item was deleted or has no payload - mark as processed to clear queue
          await queue.markProcessed(item.id)
          console.log(`[Sync] Cleared queue item ${item.id} - no payload available`)
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await queue.markFailed(item.id, errorMessage)
        result.errors.push(`Failed to encrypt ${item.type}/${item.itemId}: ${errorMessage}`)
      }
    }

    if (pushItems.length === 0) {
      return result
    }

    // Send to server
    try {
      const tokens = await getTokens()
      if (!tokens?.accessToken) {
        throw new Error('No access token available')
      }

      const response = await withRetry(() => this.sendPushRequest(pushItems, tokens.accessToken), {
        maxAttempts: 3,
        onRetry: (attempt, delay) => {
          console.log(`Push retry ${attempt}, waiting ${delay}ms`)
        }
      })

      // Process response
      for (const acceptedId of response.accepted) {
        const queueItem = items.find((i) => i.itemId === acceptedId)
        if (queueItem) {
          await queue.markProcessed(queueItem.id)
          result.pushed++
          this.emit('item-synced', {
            id: queueItem.itemId,
            type: queueItem.type as SyncItemType,
            operation: queueItem.operation as SyncOperation,
            direction: 'push'
          })
        }
      }

      // Handle conflicts
      for (const conflict of response.conflicts) {
        const queueItem = items.find((i) => i.itemId === conflict.id)
        if (queueItem) {
          await queue.markFailed(queueItem.id, `Conflict: server version ${conflict.serverVersion}`)
          result.conflicts++
          this.emit('conflict-detected', {
            id: conflict.id,
            type: conflict.type,
            localClock: this._deviceClock,
            remoteClock: conflict.serverClock
          })
        }
      }

      // Update device clock
      this._deviceClock = mergeClock(this._deviceClock, response.serverClock)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Mark items as failed if error is not retryable
      if (!isRetryableError(error)) {
        for (const id of processedIds) {
          const item = items.find((i) => i.id === id)
          if (item) {
            await queue.markFailed(item.id, errorMessage)
          }
        }
      }

      result.errors.push(`Push failed: ${errorMessage}`)
      throw error
    }

    return result
  }

  /**
   * Pull remote changes from the server.
   */
  async pull(since?: number): Promise<{ pulled: number; conflicts: number; errors: string[] }> {
    const result = { pulled: 0, conflicts: 0, errors: [] as string[] }

    try {
      const tokens = await getTokens()
      if (!tokens?.accessToken) {
        throw new Error('No access token available')
      }

      const response = await withRetry(
        () => this.sendPullRequest(since ?? this._lastSyncAt ?? undefined, tokens.accessToken),
        { maxAttempts: 3 }
      )

      // Process pulled items
      for (const item of response.items) {
        try {
          await this.processPulledItem(item)
          result.pulled++
          this.emit('item-synced', {
            id: item.id,
            type: item.type,
            operation: item.operation ?? (item.deletedAt ? 'delete' : 'update'),
            direction: 'pull'
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          result.errors.push(`Failed to process ${item.type}/${item.id}: ${errorMessage}`)
        }
      }

      // Update device clock
      this._deviceClock = mergeClock(this._deviceClock, response.serverClock)

      // Continue pulling if there's more
      if (response.hasMore) {
        const moreResult = await this.pull(response.serverTimestamp)
        result.pulled += moreResult.pulled
        result.conflicts += moreResult.conflicts
        result.errors.push(...moreResult.errors)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result.errors.push(`Pull failed: ${errorMessage}`)
      throw error
    }

    return result
  }

  /**
   * Pull a single item by ID.
   */
  async pullSingleItem(_itemId: string, _type: SyncItemType): Promise<void> {
    const tokens = await getTokens()
    if (!tokens?.accessToken) return

    try {
      // This would call a specific endpoint to get a single item
      // For now, just trigger a full pull
      await this.pull()
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Get current sync status.
   */
  getStatus(): SyncStatus {
    const networkMonitor = getNetworkMonitor()

    return {
      state: this._state,
      lastSyncAt: this._lastSyncAt ?? undefined,
      pendingCount: 0, // Will be updated async
      errorMessage: undefined,
      retryCount: 0,
      isOnline: networkMonitor.isOnline
    }
  }

  /**
   * Get current sync status asynchronously with accurate pending count.
   */
  async getStatusAsync(): Promise<SyncStatus> {
    const status = this.getStatus()
    status.pendingCount = await getSyncQueue().getPendingCount()
    return status
  }

  /**
   * Check if the sync engine is ready for operations.
   * Engine is ready when it has valid device/user IDs and is not in error state.
   */
  isReady(): boolean {
    return !!this._deviceId && !!this._userId && this._state !== 'error'
  }

  // ---------------------------------------------------------------------------
  // Internal: Encryption
  // ---------------------------------------------------------------------------

  /**
   * Encrypt a queue item for pushing.
   */
  private async encryptQueueItem(item: SyncQueueItem): Promise<SyncPushItem | null> {
    const masterKey = await getMasterKey()
    if (!masterKey) {
      throw new Error('Master key not available')
    }

    // Derive vault key
    const vaultKey = deriveVaultKey(masterKey)

    // Fetch payload if empty (on-demand data fetching)
    let payload: string | null = item.payload
    if (!payload || payload === '') {
      payload = await this.fetchPayloadForItem(
        item.type as SyncItemType,
        item.itemId,
        item.operation as SyncOperation
      )
      if (!payload) {
        // Item may have been deleted or doesn't exist
        console.warn(`[Sync] No payload found for ${item.type}/${item.itemId}, skipping`)
        return null
      }
    }
    // At this point, payload is guaranteed to be a non-empty string
    const payloadStr: string = payload

    // Encrypt the payload
    const encrypted = encryptItemToBase64(payloadStr, vaultKey)

    // Derive signing key and sign
    const signingKeySeed = deriveSigningKeySeed(masterKey)
    const { secretKey } = generateSigningKeyPair(signingKeySeed)

    const signaturePayload = {
      id: item.itemId,
      type: item.type,
      operation: item.operation,
      cryptoVersion: encrypted.cryptoVersion,
      encryptedKey: encrypted.encryptedKey,
      keyNonce: encrypted.keyNonce,
      encryptedData: encrypted.encryptedData,
      dataNonce: encrypted.dataNonce
    }

    const signature = signItem(signaturePayload, secretKey)

    // Increment device clock
    this._deviceClock = incrementClock(this._deviceClock, this._deviceId)

    return {
      id: item.itemId,
      type: item.type as SyncItemType,
      operation: item.operation as SyncOperation,
      encryptedData: JSON.stringify(encrypted),
      signature: signature.toString('base64'),
      clock: this._deviceClock
    }
  }

  /**
   * Process a pulled item (verify and decrypt).
   */
  private async processPulledItem(item: SyncPullItem): Promise<void> {
    const masterKey = await getMasterKey()
    if (!masterKey) {
      throw new Error('Master key not available')
    }

    // Parse encrypted data
    const encrypted = JSON.parse(item.encryptedData) as {
      encryptedData: string
      dataNonce: string
      encryptedKey: string
      keyNonce: string
      cryptoVersion: number
    }

    // Verify signature
    const signingKeySeed = deriveSigningKeySeed(masterKey)
    const { publicKey } = generateSigningKeyPair(signingKeySeed)

    // Use operation from server if available, otherwise infer from deletedAt
    // Note: Inference only distinguishes 'delete' vs 'update', never 'create'
    // Server should provide operation field for correct signature verification
    const operation = item.operation ?? (item.deletedAt ? 'delete' : 'update')

    const signaturePayload = {
      id: item.id,
      type: item.type,
      operation,
      cryptoVersion: encrypted.cryptoVersion,
      encryptedKey: encrypted.encryptedKey,
      keyNonce: encrypted.keyNonce,
      encryptedData: encrypted.encryptedData,
      dataNonce: encrypted.dataNonce
    }

    const signatureValid = verifyItem(
      Buffer.from(item.signature, 'base64'),
      signaturePayload,
      publicKey
    )

    if (!signatureValid) {
      throw new Error('Invalid signature')
    }

    // Derive vault key and decrypt
    const vaultKey = deriveVaultKey(masterKey)
    const decrypted = decryptItemFromBase64(
      encrypted.encryptedData,
      encrypted.dataNonce,
      encrypted.encryptedKey,
      encrypted.keyNonce,
      vaultKey
    )

    // Handle based on type and operation
    const payload = JSON.parse(decrypted)

    // Check for conflicts using vector clock
    if (item.clock) {
      const comparison = compareClock(this._deviceClock, item.clock)
      if (comparison === ClockComparison.CONCURRENT) {
        // Concurrent modification - emit conflict event
        this.emit('conflict-detected', {
          id: item.id,
          type: item.type,
          localClock: this._deviceClock,
          remoteClock: item.clock
        })
        // For now, use LWW (last write wins) - apply the remote change
      }
    }

    // Apply the change to local database
    await this.applyPulledItem(item.type, item.id, payload, item.deletedAt)

    // Update clock
    if (item.clock) {
      this._deviceClock = mergeClock(this._deviceClock, item.clock)
    }
  }

  /**
   * Apply a pulled item to the local database.
   */
  private async applyPulledItem(
    type: SyncItemType,
    id: string,
    payload: unknown,
    deletedAt?: number
  ): Promise<void> {
    // Persist to local database based on type
    if (deletedAt) {
      await this.deleteLocalItem(type, id)
    } else {
      await this.upsertLocalItem(type, id, payload)
    }

    // Then broadcast to renderer
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(SYNC_EVENTS.ITEM_SYNCED, {
        id,
        type,
        operation: deletedAt ? 'delete' : 'update',
        payload
      })
    })
  }

  /**
   * Delete a local item by type and id.
   */
  private async deleteLocalItem(type: SyncItemType, id: string): Promise<void> {
    const db = getDatabase()
    const { tasks, projects, inboxItems, savedFilters, settings } =
      await import('@shared/db/schema')

    switch (type) {
      case 'task':
        await db.delete(tasks).where(eq(tasks.id, id))
        break
      case 'project':
        await db.delete(projects).where(eq(projects.id, id))
        break
      case 'inbox_item':
        await db.delete(inboxItems).where(eq(inboxItems.id, id))
        break
      case 'saved_filter':
        await db.delete(savedFilters).where(eq(savedFilters.id, id))
        break
      case 'settings':
        await db.delete(settings).where(eq(settings.key, id))
        break
      case 'note':
        // Notes are file-based, delete via vault
        try {
          const { deleteNote } = await import('../vault/notes')
          await deleteNote(id)
        } catch (error) {
          console.warn(`[Sync] Failed to delete note ${id}:`, error)
        }
        break
      case 'attachment':
        // Attachments need special handling - file deletion
        console.warn(`[Sync] Attachment deletion not yet implemented for ${id}`)
        break
      default:
        console.warn(`[Sync] Unknown item type for deletion: ${type}`)
    }
  }

  /**
   * Upsert a local item by type and id.
   */
  private async upsertLocalItem(type: SyncItemType, _id: string, payload: unknown): Promise<void> {
    const db = getDatabase()
    const { tasks, projects, inboxItems, savedFilters, settings } =
      await import('@shared/db/schema')

    // Cast payload for type safety
    const data = payload as Record<string, unknown>
    const now = new Date().toISOString()

    switch (type) {
      case 'task': {
        await db
          .insert(tasks)
          .values({
            id: data.id as string,
            projectId: data.projectId as string,
            statusId: data.statusId as string | null,
            parentId: data.parentId as string | null,
            title: data.title as string,
            description: data.description as string | null,
            priority: (data.priority as number) ?? 0,
            position: (data.position as number) ?? 0,
            dueDate: data.dueDate as string | null,
            dueTime: data.dueTime as string | null,
            startDate: data.startDate as string | null,
            repeatConfig: data.repeatConfig as Record<string, unknown> | null,
            repeatFrom: data.repeatFrom as string | null,
            sourceNoteId: data.sourceNoteId as string | null,
            completedAt: data.completedAt as string | null,
            archivedAt: data.archivedAt as string | null,
            createdAt: (data.createdAt as string) ?? now,
            modifiedAt: (data.modifiedAt as string) ?? now,
            clock: data.clock as Record<string, number> | null
          })
          .onConflictDoUpdate({
            target: tasks.id,
            set: {
              projectId: data.projectId as string,
              statusId: data.statusId as string | null,
              parentId: data.parentId as string | null,
              title: data.title as string,
              description: data.description as string | null,
              priority: (data.priority as number) ?? 0,
              position: (data.position as number) ?? 0,
              dueDate: data.dueDate as string | null,
              dueTime: data.dueTime as string | null,
              startDate: data.startDate as string | null,
              repeatConfig: data.repeatConfig as Record<string, unknown> | null,
              repeatFrom: data.repeatFrom as string | null,
              sourceNoteId: data.sourceNoteId as string | null,
              completedAt: data.completedAt as string | null,
              archivedAt: data.archivedAt as string | null,
              modifiedAt: now,
              clock: data.clock as Record<string, number> | null
            }
          })
        break
      }
      case 'project': {
        await db
          .insert(projects)
          .values({
            id: data.id as string,
            name: data.name as string,
            description: data.description as string | null,
            color: (data.color as string) ?? '#6366f1',
            icon: data.icon as string | null,
            position: (data.position as number) ?? 0,
            isInbox: (data.isInbox as boolean) ?? false,
            createdAt: (data.createdAt as string) ?? now,
            modifiedAt: (data.modifiedAt as string) ?? now,
            archivedAt: data.archivedAt as string | null
          })
          .onConflictDoUpdate({
            target: projects.id,
            set: {
              name: data.name as string,
              description: data.description as string | null,
              color: (data.color as string) ?? '#6366f1',
              icon: data.icon as string | null,
              position: (data.position as number) ?? 0,
              isInbox: (data.isInbox as boolean) ?? false,
              modifiedAt: now,
              archivedAt: data.archivedAt as string | null
            }
          })
        break
      }
      case 'inbox_item': {
        await db
          .insert(inboxItems)
          .values({
            id: data.id as string,
            type: data.type as string,
            title: data.title as string,
            content: data.content as string | null,
            createdAt: (data.createdAt as string) ?? now,
            modifiedAt: (data.modifiedAt as string) ?? now,
            filedAt: data.filedAt as string | null,
            filedTo: data.filedTo as string | null,
            filedAction: data.filedAction as string | null,
            snoozedUntil: data.snoozedUntil as string | null,
            snoozeReason: data.snoozeReason as string | null,
            viewedAt: data.viewedAt as string | null,
            processingStatus: data.processingStatus as string | null,
            processingError: data.processingError as string | null,
            metadata: data.metadata as Record<string, unknown> | null,
            attachmentPath: data.attachmentPath as string | null,
            thumbnailPath: data.thumbnailPath as string | null,
            transcription: data.transcription as string | null,
            transcriptionStatus: data.transcriptionStatus as string | null,
            sourceUrl: data.sourceUrl as string | null,
            sourceTitle: data.sourceTitle as string | null,
            archivedAt: data.archivedAt as string | null,
            clock: data.clock as Record<string, number> | null
          })
          .onConflictDoUpdate({
            target: inboxItems.id,
            set: {
              type: data.type as string,
              title: data.title as string,
              content: data.content as string | null,
              modifiedAt: now,
              filedAt: data.filedAt as string | null,
              filedTo: data.filedTo as string | null,
              filedAction: data.filedAction as string | null,
              snoozedUntil: data.snoozedUntil as string | null,
              snoozeReason: data.snoozeReason as string | null,
              viewedAt: data.viewedAt as string | null,
              processingStatus: data.processingStatus as string | null,
              processingError: data.processingError as string | null,
              metadata: data.metadata as Record<string, unknown> | null,
              attachmentPath: data.attachmentPath as string | null,
              thumbnailPath: data.thumbnailPath as string | null,
              transcription: data.transcription as string | null,
              transcriptionStatus: data.transcriptionStatus as string | null,
              sourceUrl: data.sourceUrl as string | null,
              sourceTitle: data.sourceTitle as string | null,
              archivedAt: data.archivedAt as string | null,
              clock: data.clock as Record<string, number> | null
            }
          })
        break
      }
      case 'saved_filter': {
        await db
          .insert(savedFilters)
          .values({
            id: data.id as string,
            name: data.name as string,
            config: data.config as Record<string, unknown>,
            position: (data.position as number) ?? 0,
            createdAt: (data.createdAt as string) ?? now,
            clock: data.clock as Record<string, number> | null
          })
          .onConflictDoUpdate({
            target: savedFilters.id,
            set: {
              name: data.name as string,
              config: data.config as Record<string, unknown>,
              position: (data.position as number) ?? 0,
              clock: data.clock as Record<string, number> | null
            }
          })
        break
      }
      case 'settings': {
        await db
          .insert(settings)
          .values({
            key: data.key as string,
            value: data.value as string,
            modifiedAt: (data.modifiedAt as string) ?? now,
            clock: data.clock as Record<string, number> | null
          })
          .onConflictDoUpdate({
            target: settings.key,
            set: {
              value: data.value as string,
              modifiedAt: now,
              clock: data.clock as Record<string, number> | null
            }
          })
        break
      }
      case 'note': {
        // Notes are file-based, update via vault
        // This is handled differently - notes sync via file content
        console.log(`[Sync] Note sync received for ${data.id}, file-based sync not yet implemented`)
        break
      }
      case 'attachment':
        // Attachments need special handling
        console.warn(`[Sync] Attachment upsert not yet implemented for ${data.id}`)
        break
      default:
        console.warn(`[Sync] Unknown item type for upsert: ${type}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Payload Fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch payload for a sync item from the local database.
   * Returns serialized JSON string or null if item not found.
   */
  private async fetchPayloadForItem(
    type: SyncItemType,
    itemId: string,
    operation: SyncOperation
  ): Promise<string | null> {
    // For delete operations, we don't need the full payload
    if (operation === 'delete') {
      return JSON.stringify({ id: itemId, deleted: true })
    }

    const db = getDatabase()
    const { tasks, projects, inboxItems, savedFilters, settings } =
      await import('@shared/db/schema')

    switch (type) {
      case 'task': {
        const task = db.select().from(tasks).where(eq(tasks.id, itemId)).get()
        return task ? JSON.stringify(task) : null
      }

      case 'project': {
        const project = db.select().from(projects).where(eq(projects.id, itemId)).get()
        return project ? JSON.stringify(project) : null
      }

      case 'inbox_item': {
        const inbox = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
        return inbox ? JSON.stringify(inbox) : null
      }

      case 'saved_filter': {
        const filter = db.select().from(savedFilters).where(eq(savedFilters.id, itemId)).get()
        return filter ? JSON.stringify(filter) : null
      }

      case 'settings': {
        const setting = db.select().from(settings).where(eq(settings.key, itemId)).get()
        return setting ? JSON.stringify(setting) : null
      }

      case 'note': {
        // Notes are file-based, fetch from file system via vault
        try {
          const { getNoteById } = await import('../vault/notes')
          const fullNote = await getNoteById(itemId)
          return fullNote ? JSON.stringify(fullNote) : null
        } catch {
          return null
        }
      }

      case 'attachment': {
        // Attachments need special handling - file content needs to be read
        // For now, return basic metadata
        return JSON.stringify({ id: itemId, type: 'attachment' })
      }

      default:
        console.warn(`[Sync] Unknown item type: ${type}`)
        return null
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: API Calls
  // ---------------------------------------------------------------------------

  /**
   * Send push request to server.
   */
  private async sendPushRequest(items: SyncPushItem[], token: string): Promise<SyncPushResponse> {
    const response = await fetch(`${this.getServerUrl()}/api/v1/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        items,
        deviceClock: this._deviceClock
      })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.message || `Push failed with status ${response.status}`)
    }

    return response.json()
  }

  /**
   * Send pull request to server.
   */
  private async sendPullRequest(
    since: number | undefined,
    token: string
  ): Promise<SyncPullResponse> {
    const url = `${this.getServerUrl()}/api/v1/sync/pull`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        deviceClock: this._deviceClock,
        since,
        limit: this._config.pullBatchSize
      })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }))
      throw new Error(error.message || `Pull failed with status ${response.status}`)
    }

    return response.json()
  }

  private getServerUrl(): string {
    return process.env.SYNC_SERVER_URL || 'https://api.memry.app'
  }

  // ---------------------------------------------------------------------------
  // Internal: State Management
  // ---------------------------------------------------------------------------

  /**
   * Set sync state and emit event.
   */
  private setState(state: SyncState): void {
    if (this._state === state) return
    this._state = state

    const status = this.getStatus()
    this.emit('status-changed', status)

    // Broadcast to renderer
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(SYNC_EVENTS.STATUS_CHANGED, status)
    })
  }

  /**
   * Load state from database.
   */
  private async loadState(): Promise<void> {
    const db = getDatabase()

    // Load device clock
    const clockEntry = await db.query.syncState.findFirst({
      where: eq(syncState.key, SYNC_STATE_KEYS.DEVICE_CLOCK)
    })
    if (clockEntry) {
      this._deviceClock = deserializeClock(clockEntry.value)
    }

    // Load last sync time
    const lastSyncEntry = await db.query.syncState.findFirst({
      where: eq(syncState.key, SYNC_STATE_KEYS.LAST_SYNC_AT)
    })
    if (lastSyncEntry) {
      this._lastSyncAt = parseInt(lastSyncEntry.value, 10)
    }
  }

  /**
   * Save state to database.
   */
  private async saveState(): Promise<void> {
    const db = getDatabase()
    const now = new Date().toISOString()

    // Save device clock
    await db
      .insert(syncState)
      .values({
        key: SYNC_STATE_KEYS.DEVICE_CLOCK,
        value: serializeClock(this._deviceClock),
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: syncState.key,
        set: {
          value: serializeClock(this._deviceClock),
          updatedAt: now
        }
      })

    // Save last sync time
    if (this._lastSyncAt) {
      await db
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.LAST_SYNC_AT,
          value: String(this._lastSyncAt),
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: syncState.key,
          set: {
            value: String(this._lastSyncAt),
            updatedAt: now
          }
        })
    }
  }

  /**
   * Record a sync history entry.
   */
  private async recordHistory(
    type: 'push' | 'pull' | 'error',
    itemCount: number,
    direction: 'upload' | 'download',
    durationMs: number
  ): Promise<void> {
    const db = getDatabase()

    await db.insert(syncHistory).values({
      id: nanoid(),
      type,
      itemCount,
      direction,
      durationMs,
      createdAt: new Date().toISOString()
    })
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Singleton sync engine instance */
let _syncEngine: SyncEngine | null = null

/**
 * Get the sync engine singleton.
 *
 * @returns SyncEngine instance
 */
export function getSyncEngine(): SyncEngine {
  if (!_syncEngine) {
    _syncEngine = new SyncEngine()
  }
  return _syncEngine
}

/**
 * Reset the sync engine singleton (for testing).
 */
export async function resetSyncEngine(): Promise<void> {
  if (_syncEngine) {
    await _syncEngine.stop()
    _syncEngine.removeAllListeners()
    _syncEngine = null
  }
}
