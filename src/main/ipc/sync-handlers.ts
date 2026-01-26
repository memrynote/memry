/**
 * Sync IPC handlers.
 * Handles all sync-related IPC communication from renderer.
 *
 * T050c: Device registration IPC
 * T050d: Persist device_id locally
 * T050f: Wire into setup flow
 *
 * @module ipc/sync-handlers
 */

import { ipcMain, BrowserWindow, app } from 'electron'
import os from 'node:os'
import { SyncChannels } from '@shared/contracts/ipc-sync'
import { InboxChannels, SavedFiltersChannels, SettingsChannels, TasksChannels } from '@shared/ipc-channels'
import type {
  GetSyncStatusResponse,
  TriggerSyncResponse,
  GetQueueSizeResponse,
  GetDevicesResponse,
  CreateLinkingSessionResponse,
  ScanLinkingQRResponse,
  ApproveLinkingResponse,
  CompleteLinkingResponse,
  GetLinkingStatusResponse,
  RenameDeviceResponse,
  RevokeDeviceResponse,
  GetConflictsResponse,
  ResolveConflictResponse,
  SetupFirstDeviceResponse,
  SetupFirstDeviceRequest,
  VerifyRecoveryPhraseResponse,
  RegisterExistingDeviceRequest,
  RegisterExistingDeviceResponse
} from '@shared/contracts/ipc-sync'
import type { Device, UserPublic, SyncState, DevicePlatform } from '@shared/contracts/sync-api'
import {
  TriggerSyncRequestSchema,
  SetupFirstDeviceRequestSchema,
  VerifyRecoveryPhraseRequestSchema,
  RegisterExistingDeviceRequestSchema,
  ScanLinkingQRRequestSchema,
  RenameDeviceRequestSchema,
  RevokeDeviceRequestSchema,
  ResolveConflictRequestSchema
} from '@shared/contracts/ipc-sync'
import { eq } from 'drizzle-orm'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { z } from 'zod'
import {
  generateDeviceSigningKeyPair,
  storeDeviceKeyPair,
  retrieveDeviceKeyPair,
  hasDeviceKeyPair,
  uint8ArrayToBase64,
  base64ToUint8Array,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  phraseToEntropy,
  deriveMasterKey,
  deriveAllKeys,
  generateSalt,
  generateNonce,
  generateKeyVerifier,
  storeKeyMaterial,
  retrieveKeyMaterial,
  storeSigningKeyPair,
  retrieveAuthTokens,
  storeAuthTokens,
  sign,
  secureZero,
  secureZeroSync,
  isCryptoError,
  constantTimeEqual,
  generateLinkingKeyPair,
  deriveLinkingKeys,
  computeLinkingProof,
  encryptMasterKeyForLinking,
  decryptMasterKeyFromLinking
} from '../crypto'
import {
  LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER,
  LINKING_KEY_CONFIRM_FIELD_ORDER
} from '@shared/contracts/cbor-ordering'
import { validateLinkingQRPayload, LINKING_CONSTANTS } from '@shared/contracts/linking-api'
import type { LinkingQRPayload } from '@shared/contracts/linking-api'
import type { ScanLinkingQRRequest } from '@shared/contracts/ipc-sync'
import QRCode from 'qrcode'
import { getSyncApiClient, createApiClientWithUrl, isSyncApiError } from '../sync/api-client'
import { getSyncEngine } from '../sync/engine'
import { bootstrapSyncData } from '../sync/bootstrap'
import { triggerPostSetupSync } from '../sync/auth-bridge'
import { resetSyncStateForNewDevice } from '../sync/state-reset'
import type { DecryptedSyncItem } from '../sync/engine'
import { getSyncQueue } from '../sync/queue'
import { getNetworkMonitor } from '../sync/network'
import { getDatabase } from '../database/client'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import { tasks } from '@shared/db/schema/tasks'
import { devices as devicesTable } from '@shared/db/schema/sync-schema'

function emitSyncEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

// =============================================================================
// Linking Session State Management
// =============================================================================

interface LinkingSessionState {
  sessionId: string
  privateKey: Uint8Array
  publicKey: string
  serverPublicKey?: string
  derivedKeys?: {
    encryptionKey: Uint8Array
    macKey: Uint8Array
  }
  newDevicePublicKey?: string
  serverUrl?: string
  linkingToken?: string
  createdAt: number
  expiresAt: number
}

const linkingSessions = new Map<string, LinkingSessionState>()
const MAX_LINKING_SESSIONS = 10

function cleanupExpiredSessions(): void {
  const now = Date.now()
  for (const [sessionId, session] of linkingSessions) {
    if (session.expiresAt < now) {
      if (session.privateKey) {
        secureZeroSync(session.privateKey)
      }
      if (session.derivedKeys) {
        secureZeroSync(session.derivedKeys.encryptionKey)
        secureZeroSync(session.derivedKeys.macKey)
      }
      linkingSessions.delete(sessionId)
    }
  }
}

function storeLinkingSession(session: LinkingSessionState): void {
  cleanupExpiredSessions()

  if (linkingSessions.size >= MAX_LINKING_SESSIONS) {
    const oldestKey = linkingSessions.keys().next().value
    if (oldestKey) {
      deleteLinkingSession(oldestKey)
    }
  }

  linkingSessions.set(session.sessionId, session)
}

function getLinkingSessionState(sessionId: string): LinkingSessionState | undefined {
  cleanupExpiredSessions()
  return linkingSessions.get(sessionId)
}

function deleteLinkingSession(sessionId: string): void {
  const session = linkingSessions.get(sessionId)
  if (session) {
    if (session.privateKey) {
      secureZeroSync(session.privateKey)
    }
    if (session.derivedKeys) {
      secureZeroSync(session.derivedKeys.encryptionKey)
      secureZeroSync(session.derivedKeys.macKey)
    }
    linkingSessions.delete(sessionId)
  }
}

function createNotImplementedResponse(): { success: false; error: string } {
  return { success: false, error: 'Sync not yet implemented' }
}

function getDefaultSyncState(): SyncState {
  return {
    syncStatus: 'idle',
    pendingCount: 0,
    serverCursor: 0,
    deviceClock: {}
  }
}

async function fetchAndStoreAccountDevices(): Promise<void> {
  const storedTokens = await retrieveAuthTokens()
  if (!storedTokens?.accessToken) return

  try {
    const client = getSyncApiClient()
    const { devices } = await client.getAccountDevices(storedTokens.accessToken)

    const db = getDatabase()

    for (const device of devices) {
      if (!device.authPublicKey) continue

      db.insert(devicesTable)
        .values({
          id: device.id,
          name: device.name,
          platform: device.platform,
          osVersion: device.osVersion ?? null,
          appVersion: device.appVersion,
          authPublicKey: device.authPublicKey,
          linkedAt: new Date(device.linkedAt).toISOString(),
          lastSyncAt: device.lastSyncAt ? new Date(device.lastSyncAt).toISOString() : null,
          isCurrentDevice: false
        })
        .onConflictDoUpdate({
          target: devicesTable.id,
          set: {
            name: device.name,
            authPublicKey: device.authPublicKey,
            lastSyncAt: device.lastSyncAt ? new Date(device.lastSyncAt).toISOString() : null
          }
        })
        .run()
    }

    console.info('[Sync] Stored account devices', { count: devices.length })
  } catch (error) {
    console.warn('[Sync] Failed to fetch account devices:', error)
  }
}

function decodeDeviceIdFromAccessToken(token?: string): string | null {
  if (!token) {
    return null
  }
  try {
    const payload = token.split('.')[1]
    if (!payload) {
      return null
    }
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as { deviceId?: string }
    return typeof parsed.deviceId === 'string' ? parsed.deviceId : null
  } catch (error) {
    console.warn('[Sync] Failed to decode device ID from access token:', error)
    return null
  }
}

async function handleDecryptedSyncItem(item: DecryptedSyncItem): Promise<void> {
  try {
    if (item.itemType === 'inbox') {
      const db = getDatabase()
      if (item.deleted) {
        db.delete(inboxItems).where(eq(inboxItems.id, item.itemId)).run()
        emitSyncEvent(InboxChannels.events.ARCHIVED, { id: item.itemId })
        return
      }

      const payload = {
        ...(item.data as Record<string, unknown>),
        id: item.itemId
      } as typeof inboxItems.$inferInsert

      db.insert(inboxItems)
        .values(payload)
        .onConflictDoUpdate({
          target: inboxItems.id,
          set: payload
        })
        .run()

      emitSyncEvent(InboxChannels.events.UPDATED, { id: item.itemId, inboxItem: payload })
      return
    }

    if (item.itemType === 'filter') {
      const db = getDatabase()
      if (item.deleted) {
        db.delete(savedFilters).where(eq(savedFilters.id, item.itemId)).run()
        emitSyncEvent(SavedFiltersChannels.events.DELETED, { id: item.itemId })
        return
      }

      const payload = {
        ...(item.data as Record<string, unknown>),
        id: item.itemId
      } as typeof savedFilters.$inferInsert

      db.insert(savedFilters)
        .values(payload)
        .onConflictDoUpdate({
          target: savedFilters.id,
          set: payload
        })
        .run()

      emitSyncEvent(SavedFiltersChannels.events.UPDATED, { id: item.itemId, savedFilter: payload })
      return
    }

    if (item.itemType === 'task') {
      const db = getDatabase()
      if (item.deleted) {
        db.delete(tasks).where(eq(tasks.id, item.itemId)).run()
        emitSyncEvent(TasksChannels.events.DELETED, { id: item.itemId })
        return
      }

      const payload = {
        ...(item.data as Record<string, unknown>),
        id: item.itemId,
        clock: item.clock ? JSON.stringify(item.clock) : null
      } as typeof tasks.$inferInsert

      db.insert(tasks)
        .values(payload)
        .onConflictDoUpdate({
          target: tasks.id,
          set: payload
        })
        .run()

      emitSyncEvent(TasksChannels.events.UPDATED, { id: item.itemId, task: payload })
      return
    }

    if (item.itemType === 'settings') {
      emitSyncEvent(SettingsChannels.events.CHANGED, {
        key: 'sync.settings',
        value: item.data
      })
    }
  } catch (error) {
    console.warn('[Sync] Failed to apply synced item:', error)
  }
}

let decryptedItemListener: ((item: DecryptedSyncItem) => void) | null = null

export function registerDecryptedItemListener(): void {
  const engine = getSyncEngine()
  if (engine && !decryptedItemListener) {
    decryptedItemListener = (item) => {
      void handleDecryptedSyncItem(item)
    }
    engine.on('sync:item-decrypted', decryptedItemListener)
    console.info('[Sync] Registered decrypted item listener')
  }
}

export function registerSyncHandlers(): void {
  registerDecryptedItemListener()

  // ============================================================================
  // Status & Control
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_SYNC_STATUS,
    createHandler(async (): Promise<GetSyncStatusResponse> => {
      const engine = getSyncEngine()
      const queue = getSyncQueue()
      const networkMonitor = getNetworkMonitor()

      if (!engine) {
        return {
          state: getDefaultSyncState(),
          isOnline: networkMonitor.isOnline()
        }
      }

      const [serverCursor, lastSyncAt, deviceClock] = await Promise.all([
        engine.getServerCursor(),
        engine.getLastSyncAt(),
        engine.getDeviceClockPublic()
      ])

      return {
        state: {
          syncStatus: engine.status,
          pendingCount: queue.size(),
          serverCursor,
          deviceClock,
          lastSyncAt
        },
        isOnline: networkMonitor.isOnline()
      }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.TRIGGER_SYNC,
    createValidatedHandler(
      TriggerSyncRequestSchema.optional(),
      async (): Promise<TriggerSyncResponse> => {
        const engine = getSyncEngine()
        const networkMonitor = getNetworkMonitor()

        if (!engine) {
          return {
            success: false,
            itemsSynced: 0,
            errors: ['Sync engine not initialized']
          }
        }

        if (!networkMonitor.isOnline()) {
          return {
            success: false,
            itemsSynced: 0,
            errors: ['Device is offline']
          }
        }

        if (engine.isSyncing) {
          return {
            success: false,
            itemsSynced: 0,
            errors: ['Sync already in progress']
          }
        }

        if (engine.status === 'paused') {
          return {
            success: false,
            itemsSynced: 0,
            errors: ['Sync is paused']
          }
        }

        try {
          const queue = getSyncQueue()
          const pendingBefore = queue.size()

          await engine.sync()

          const pendingAfter = queue.size()
          const itemsSynced = pendingBefore - pendingAfter

          return {
            success: true,
            itemsSynced: Math.max(0, itemsSynced)
          }
        } catch (error) {
          console.error('[Sync] TRIGGER_SYNC error:', error)
          return {
            success: false,
            itemsSynced: 0,
            errors: [error instanceof Error ? error.message : 'Sync failed']
          }
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.PAUSE_SYNC,
    createHandler(async (): Promise<{ success: boolean; error?: string }> => {
      const engine = getSyncEngine()

      if (!engine) {
        return { success: false, error: 'Sync engine not initialized' }
      }

      engine.pause()
      return { success: true }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.RESUME_SYNC,
    createHandler(async (): Promise<{ success: boolean; error?: string }> => {
      const engine = getSyncEngine()

      if (!engine) {
        return { success: false, error: 'Sync engine not initialized' }
      }

      engine.resume()
      return { success: true }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_SYNC_HISTORY,
    createHandler(() => ({ history: [] }))
  )

  ipcMain.handle(
    SyncChannels.invoke.CLEAR_SYNC_QUEUE,
    createHandler(() => createNotImplementedResponse())
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_QUEUE_SIZE,
    createHandler((): GetQueueSizeResponse => {
      const queue = getSyncQueue()
      const size = queue.size()
      return {
        size,
        isEmpty: size === 0
      }
    })
  )

  // ============================================================================
  // First Device Setup (T050c, T050d, T050f)
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.SETUP_FIRST_DEVICE,
    createValidatedHandler(
      SetupFirstDeviceRequestSchema,
      async (input: SetupFirstDeviceRequest): Promise<SetupFirstDeviceResponse> => {
        let entropy: Uint8Array | null = null
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null
        let keyVerifier: Uint8Array | null = null

        try {
          // Step 1: Generate recovery phrase
          const recoveryPhrase = generateRecoveryPhrase()

          // Step 2: Derive master key from entropy + salt
          entropy = phraseToEntropy(recoveryPhrase)
          const kdfSaltBuffer = await generateSalt()
          const kdfSaltB64 = uint8ArrayToBase64(kdfSaltBuffer)
          masterKey = deriveMasterKey(entropy, kdfSaltBuffer)

          // Step 3: Generate key verifier (T058)
          keyVerifier = await generateKeyVerifier(masterKey)
          const keyVerifierB64 = uint8ArrayToBase64(keyVerifier)

          // Step 4: Derive all sub-keys
          derivedKeys = await deriveAllKeys(masterKey)

          // Step 5: Resolve device ID from auth context (fallback for offline setups)
          const storedTokens = await retrieveAuthTokens()
          const deviceIdFromToken =
            storedTokens?.deviceId ?? decodeDeviceIdFromAccessToken(storedTokens?.accessToken)
          if (storedTokens?.accessToken && !deviceIdFromToken) {
            throw new Error('Missing device identifier for authenticated setup')
          }
          const deviceId = deviceIdFromToken ?? crypto.randomUUID()

          // Step 6: Generate device signing keypair (T061a)
          const deviceKeyPair = await generateDeviceSigningKeyPair(deviceId)

          // Step 7: Store device keypair in keychain
          await storeDeviceKeyPair(deviceKeyPair)

          // Step 8: Store derived signing keypair in keychain (T060a)
          await storeSigningKeyPair({
            publicKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.publicKey),
            privateKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.privateKey)
          })

          // Step 9: Try to call server with kdfSalt + keyVerifier (if authenticated)
          let userId = ''
          let email = ''

          if (storedTokens?.accessToken) {
            try {
              const client = getSyncApiClient()
              await client.setupFirstDevice(storedTokens.accessToken, {
                kdfSalt: kdfSaltB64,
                keyVerifier: keyVerifierB64
              })
              userId = storedTokens.userId
              email = storedTokens.email
            } catch (serverError) {
              console.warn(
                '[Sync] Server setup failed, continuing with local-only setup:',
                serverError
              )
            }
          }

          const authPublicKey = uint8ArrayToBase64(deviceKeyPair.publicKey)

          // Step 10: Register device with server (best-effort, requires auth)
          if (storedTokens?.accessToken) {
            try {
              const challengeNonce = await generateNonce()
              const signature = await sign(challengeNonce, deviceKeyPair.privateKey)
              const client = getSyncApiClient()
              await client.registerDevice(storedTokens.accessToken, {
                name: input.deviceName,
                platform: input.platform,
                osVersion: input.osVersion,
                appVersion: input.appVersion,
                authPublicKey,
                challengeNonce: uint8ArrayToBase64(challengeNonce),
                challengeSignature: uint8ArrayToBase64(signature)
              })
            } catch (deviceError) {
              console.warn(
                '[Sync] Device registration failed, continuing with local-only setup:',
                deviceError
              )
            }
          }

          // Step 11: Store master key material in keychain (T061)
          await storeKeyMaterial({
            masterKey: uint8ArrayToBase64(masterKey),
            kdfSalt: kdfSaltB64,
            deviceSigningKey: uint8ArrayToBase64(deviceKeyPair.privateKey),
            devicePublicKey: uint8ArrayToBase64(deviceKeyPair.publicKey),
            deviceId,
            userId
          })

          await fetchAndStoreAccountDevices()
          await resetSyncStateForNewDevice()
          void triggerPostSetupSync()

          const now = Date.now()

          const device: Device = {
            id: deviceId,
            name: input.deviceName,
            platform: input.platform as DevicePlatform,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            authPublicKey,
            linkedAt: now,
            isCurrentDevice: true
          }

          const user: UserPublic = {
            id: userId,
            email,
            emailVerified: !!email,
            authMethod: 'email',
            storageUsed: 0,
            storageLimit: 1024 * 1024 * 1024,
            createdAt: now,
            updatedAt: now
          }

          void bootstrapSyncData()

          return {
            recoveryPhrase,
            device,
            user
          }
        } catch (error) {
          console.error('[Sync] SETUP_FIRST_DEVICE error:', error)
          const message = isCryptoError(error)
            ? error.message
            : isSyncApiError(error)
              ? error.message
              : 'First device setup failed'
          throw new Error(message)
        } finally {
          if (entropy) await secureZero(entropy)
          if (masterKey) await secureZero(masterKey)
          if (keyVerifier) await secureZero(keyVerifier)
          if (derivedKeys) {
            await secureZero(derivedKeys.vaultKey)
            await secureZero(derivedKeys.signingKeyPair.publicKey)
            await secureZero(derivedKeys.signingKeyPair.privateKey)
            await secureZero(derivedKeys.verifyKey)
          }
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.VERIFY_RECOVERY_PHRASE,
    createValidatedHandler(
      VerifyRecoveryPhraseRequestSchema,
      async ({ phrase }): Promise<VerifyRecoveryPhraseResponse> => {
        let derivedMasterKey: Uint8Array | null = null

        try {
          // Step 1: Validate BIP39 phrase format
          if (!validateRecoveryPhrase(phrase)) {
            return { valid: false, error: 'Invalid recovery phrase format' }
          }

          // Step 2: Get stored key material
          const storedMaterial = await retrieveKeyMaterial()
          if (!storedMaterial) {
            return { valid: false, error: 'No keys stored - setup not complete' }
          }

          // Step 3: Check if kdfSalt is available
          if (!storedMaterial.kdfSalt) {
            return { valid: false, error: 'KDF salt not stored - cannot verify phrase' }
          }

          // Step 4: Derive master key from entered phrase using stored salt
          const entropy = phraseToEntropy(phrase)
          const salt = base64ToUint8Array(storedMaterial.kdfSalt)
          derivedMasterKey = deriveMasterKey(entropy, salt)

          // Step 5: Compare with stored master key using constant-time comparison
          const storedMasterKey = base64ToUint8Array(storedMaterial.masterKey)
          const matches = constantTimeEqual(derivedMasterKey, storedMasterKey)

          return {
            valid: matches,
            error: matches ? undefined : 'Recovery phrase does not match'
          }
        } catch (error) {
          console.error('[Sync] VERIFY_RECOVERY_PHRASE error:', error)
          const message = isCryptoError(error)
            ? error.message
            : 'Recovery phrase verification failed'
          return { valid: false, error: message }
        } finally {
          if (derivedMasterKey) await secureZero(derivedMasterKey)
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_RECOVERY_PHRASE,
    createHandler(() => ({ phrase: [] as string[] }))
  )

  ipcMain.handle(
    SyncChannels.invoke.REGISTER_EXISTING_DEVICE,
    createValidatedHandler(
      RegisterExistingDeviceRequestSchema,
      async (input: RegisterExistingDeviceRequest): Promise<RegisterExistingDeviceResponse> => {
        let entropy: Uint8Array | null = null
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null

        try {
          if (!validateRecoveryPhrase(input.recoveryPhrase)) {
            return { success: false, error: 'Invalid recovery phrase format' }
          }

          const storedTokens = await retrieveAuthTokens()
          if (!storedTokens?.accessToken) {
            return { success: false, error: 'Not authenticated' }
          }

          const client = getSyncApiClient()
          let recoveryInfo: { kdfSalt: string; keyVerifier: string }
          try {
            recoveryInfo = await client.getRecoveryInfo(storedTokens.accessToken)
          } catch (error) {
            console.error('[Sync] Failed to get recovery info:', error)
            return { success: false, error: 'Failed to get recovery info from server' }
          }

          entropy = phraseToEntropy(input.recoveryPhrase)
          const kdfSaltBuffer = base64ToUint8Array(recoveryInfo.kdfSalt)
          masterKey = deriveMasterKey(entropy, kdfSaltBuffer)

          const computedVerifier = await generateKeyVerifier(masterKey)
          const storedVerifier = base64ToUint8Array(recoveryInfo.keyVerifier)
          if (!constantTimeEqual(computedVerifier, storedVerifier)) {
            return { success: false, error: 'Invalid recovery phrase - does not match account' }
          }

          derivedKeys = await deriveAllKeys(masterKey)

          const deviceIdFromToken =
            storedTokens.deviceId ?? decodeDeviceIdFromAccessToken(storedTokens.accessToken)
          if (!deviceIdFromToken) {
            return { success: false, error: 'Missing device identifier' }
          }

          const deviceKeyPair = await generateDeviceSigningKeyPair(deviceIdFromToken)
          await storeDeviceKeyPair(deviceKeyPair)

          await storeSigningKeyPair({
            publicKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.publicKey),
            privateKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.privateKey)
          })

          const authPublicKey = uint8ArrayToBase64(deviceKeyPair.publicKey)

          try {
            const challengeNonce = await generateNonce()
            const signature = await sign(challengeNonce, deviceKeyPair.privateKey)
            await client.registerDevice(storedTokens.accessToken, {
              name: input.deviceName,
              platform: input.platform,
              osVersion: input.osVersion,
              appVersion: input.appVersion,
              authPublicKey,
              challengeNonce: uint8ArrayToBase64(challengeNonce),
              challengeSignature: uint8ArrayToBase64(signature)
            })
          } catch (deviceError) {
            console.error('[Sync] Device registration failed:', deviceError)
            return { success: false, error: 'Failed to register device with server' }
          }

          await storeKeyMaterial({
            masterKey: uint8ArrayToBase64(masterKey),
            kdfSalt: recoveryInfo.kdfSalt,
            deviceSigningKey: uint8ArrayToBase64(deviceKeyPair.privateKey),
            devicePublicKey: uint8ArrayToBase64(deviceKeyPair.publicKey),
            deviceId: deviceIdFromToken,
            userId: storedTokens.userId
          })

          await fetchAndStoreAccountDevices()
          await resetSyncStateForNewDevice()
          void triggerPostSetupSync()

          const now = Date.now()
          const device: Device = {
            id: deviceIdFromToken,
            name: input.deviceName,
            platform: input.platform as DevicePlatform,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            authPublicKey,
            linkedAt: now,
            isCurrentDevice: true
          }

          return { success: true, device }
        } catch (error) {
          console.error('[Sync] REGISTER_EXISTING_DEVICE error:', error)
          const message = isCryptoError(error)
            ? error.message
            : isSyncApiError(error)
              ? error.message
              : 'Device registration failed'
          return { success: false, error: message }
        } finally {
          if (entropy) await secureZero(entropy)
          if (masterKey) await secureZero(masterKey)
          if (derivedKeys) {
            await secureZero(derivedKeys.vaultKey)
            await secureZero(derivedKeys.signingKeyPair.publicKey)
            await secureZero(derivedKeys.signingKeyPair.privateKey)
            await secureZero(derivedKeys.verifyKey)
          }
        }
      }
    )
  )

  // ============================================================================
  // Device Linking (T112, T113, T114)
  // ============================================================================

  /**
   * T112: CREATE_LINKING_SESSION
   * Called by existing device to initiate device linking.
   * Generates ephemeral X25519 keypair, calls server, returns QR code.
   */
  ipcMain.handle(
    SyncChannels.invoke.CREATE_LINKING_SESSION,
    createHandler(async (): Promise<CreateLinkingSessionResponse> => {
      try {
        const storedTokens = await retrieveAuthTokens()
        if (!storedTokens?.accessToken) {
          throw new Error('Not authenticated')
        }

        const deviceKeyPair = await retrieveDeviceKeyPair()
        if (!deviceKeyPair) {
          throw new Error('Device not registered')
        }

        const linkingKeyPair = await generateLinkingKeyPair()

        const client = getSyncApiClient()
        const response = await client.initiateLinking(
          storedTokens.accessToken,
          deviceKeyPair.deviceId,
          linkingKeyPair.publicKey
        )

        const qrCodeDataUrl = await QRCode.toDataURL(response.qrPayload, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 256
        })

        storeLinkingSession({
          sessionId: response.sessionId,
          privateKey: base64ToUint8Array(linkingKeyPair.privateKey),
          publicKey: linkingKeyPair.publicKey,
          createdAt: Date.now(),
          expiresAt: response.expiresAt
        })

        return {
          sessionId: response.sessionId,
          qrCodeDataUrl,
          expiresAt: response.expiresAt
        }
      } catch (error) {
        console.error('[Sync] CREATE_LINKING_SESSION error:', error)
        return {
          sessionId: '',
          qrCodeDataUrl: '',
          expiresAt: 0,
          error: error instanceof Error ? error.message : 'Failed to create linking session'
        }
      }
    })
  )

  /**
   * T113: SCAN_LINKING_QR
   * Called by new device after scanning QR code.
   * Generates own keypair, performs ECDH, computes proof, calls server.
   */
  ipcMain.handle(
    SyncChannels.invoke.SCAN_LINKING_QR,
    createValidatedHandler(
      ScanLinkingQRRequestSchema,
      async (input: ScanLinkingQRRequest): Promise<ScanLinkingQRResponse> => {
        let derivedKeys: Awaited<ReturnType<typeof deriveLinkingKeys>> | null = null

        try {
          let qrPayload: LinkingQRPayload
          try {
            qrPayload = validateLinkingQRPayload(JSON.parse(input.qrContent))
          } catch {
            return { success: false, error: 'Invalid QR code format' }
          }

          const linkingKeyPair = await generateLinkingKeyPair()
          const myPrivateKey = base64ToUint8Array(linkingKeyPair.privateKey)
          const myPrivateKeyCopy = new Uint8Array(myPrivateKey)
          const serverPublicKey = base64ToUint8Array(qrPayload.ephemeralPublicKey)

          derivedKeys = await deriveLinkingKeys(myPrivateKey, serverPublicKey)

          const proofPayload = {
            sessionId: qrPayload.sessionId,
            token: qrPayload.token,
            newDevicePublicKey: linkingKeyPair.publicKey
          }
          const newDeviceConfirm = computeLinkingProof(
            derivedKeys.macKey,
            proofPayload,
            LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER
          )

          const client = createApiClientWithUrl(qrPayload.serverUrl)
          await client.scanLinking({
            sessionId: qrPayload.sessionId,
            token: qrPayload.token,
            newDevicePublicKey: linkingKeyPair.publicKey,
            newDeviceConfirm: uint8ArrayToBase64(newDeviceConfirm)
          })

          storeLinkingSession({
            sessionId: qrPayload.sessionId,
            privateKey: myPrivateKeyCopy,
            publicKey: linkingKeyPair.publicKey,
            serverPublicKey: qrPayload.ephemeralPublicKey,
            derivedKeys: {
              encryptionKey: derivedKeys.encryptionKey,
              macKey: derivedKeys.macKey
            },
            serverUrl: qrPayload.serverUrl,
            linkingToken: qrPayload.token,
            createdAt: Date.now(),
            expiresAt: Date.now() + LINKING_CONSTANTS.SESSION_EXPIRY_MS
          })

          await secureZero(myPrivateKey)
          derivedKeys = null

          return {
            success: true,
            sessionId: qrPayload.sessionId
          }
        } catch (error) {
          console.error('[Sync] SCAN_LINKING_QR error:', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : 'QR scan failed'
          }
        } finally {
          if (derivedKeys) {
            await secureZero(derivedKeys.encryptionKey)
            await secureZero(derivedKeys.macKey)
          }
        }
      }
    )
  )

  /**
   * T114: APPROVE_LINKING
   * Called by existing device to approve linking and transfer master key.
   * Performs ECDH with new device's key, encrypts master key, computes proof.
   */
  ipcMain.handle(
    SyncChannels.invoke.APPROVE_LINKING,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async ({ sessionId }): Promise<ApproveLinkingResponse> => {
        let derivedKeys: Awaited<ReturnType<typeof deriveLinkingKeys>> | null = null
        let masterKeyBytes: Uint8Array | null = null

        try {
          const storedTokens = await retrieveAuthTokens()
          if (!storedTokens?.accessToken) {
            return { success: false, error: 'Not authenticated' }
          }

          const session = getLinkingSessionState(sessionId)
          if (!session) {
            return { success: false, error: 'Linking session not found or expired' }
          }

          const client = getSyncApiClient()
          const statusResponse = await client.getLinkingStatus(storedTokens.accessToken, sessionId)
          if (!statusResponse.newDevicePublicKey) {
            return { success: false, error: 'New device has not scanned QR code yet' }
          }

          const newDevicePublicKey = base64ToUint8Array(statusResponse.newDevicePublicKey)
          derivedKeys = await deriveLinkingKeys(session.privateKey, newDevicePublicKey)

          const keyMaterial = await retrieveKeyMaterial()
          if (!keyMaterial) {
            return { success: false, error: 'No master key found' }
          }

          masterKeyBytes = base64ToUint8Array(keyMaterial.masterKey)
          const { ciphertext, nonce } = await encryptMasterKeyForLinking(
            masterKeyBytes,
            derivedKeys.encryptionKey
          )

          const proofPayload = {
            sessionId,
            encryptedMasterKey: uint8ArrayToBase64(ciphertext),
            encryptedKeyNonce: uint8ArrayToBase64(nonce)
          }
          const keyConfirm = computeLinkingProof(
            derivedKeys.macKey,
            proofPayload,
            LINKING_KEY_CONFIRM_FIELD_ORDER
          )

          await client.approveLinking(storedTokens.accessToken, {
            sessionId,
            encryptedMasterKey: uint8ArrayToBase64(ciphertext),
            encryptedKeyNonce: uint8ArrayToBase64(nonce),
            keyConfirm: uint8ArrayToBase64(keyConfirm)
          })

          deleteLinkingSession(sessionId)

          return { success: true }
        } catch (error) {
          console.error('[Sync] APPROVE_LINKING error:', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Approval failed'
          }
        } finally {
          if (derivedKeys) {
            await secureZero(derivedKeys.encryptionKey)
            await secureZero(derivedKeys.macKey)
          }
          if (masterKeyBytes) {
            await secureZero(masterKeyBytes)
          }
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.COMPLETE_LINKING,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async ({ sessionId }): Promise<CompleteLinkingResponse> => {
        let masterKey: Uint8Array | null = null
        let derivedKeys: Awaited<ReturnType<typeof deriveAllKeys>> | null = null

        try {
          const session = getLinkingSessionState(sessionId)
          if (!session) {
            return { success: false, error: 'Linking session not found or expired' }
          }

          if (!session.derivedKeys || !session.linkingToken || !session.serverUrl) {
            return { success: false, error: 'Incomplete linking session state' }
          }

          const proofPayload = {
            sessionId,
            token: session.linkingToken,
            newDevicePublicKey: session.publicKey
          }
          const newDeviceConfirm = computeLinkingProof(
            session.derivedKeys.macKey,
            proofPayload,
            LINKING_NEW_DEVICE_CONFIRM_FIELD_ORDER
          )

          const client = createApiClientWithUrl(session.serverUrl)
          const response = await client.completeLinking({
            sessionId,
            token: session.linkingToken,
            newDeviceConfirm: uint8ArrayToBase64(newDeviceConfirm)
          })

          const encryptedMasterKey = base64ToUint8Array(response.encryptedMasterKey)
          const encryptedKeyNonce = base64ToUint8Array(response.encryptedKeyNonce)
          masterKey = await decryptMasterKeyFromLinking(
            encryptedMasterKey,
            encryptedKeyNonce,
            session.derivedKeys.encryptionKey
          )

          derivedKeys = await deriveAllKeys(masterKey)

          const deviceId = response.device.id
          const deviceKeyPair = await generateDeviceSigningKeyPair(deviceId)
          await storeDeviceKeyPair(deviceKeyPair)

          await storeSigningKeyPair({
            publicKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.publicKey),
            privateKey: uint8ArrayToBase64(derivedKeys.signingKeyPair.privateKey)
          })

          await storeAuthTokens({
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            userId: response.device.userId ?? '',
            email: '',
            deviceId
          })

          await storeKeyMaterial({
            masterKey: uint8ArrayToBase64(masterKey),
            kdfSalt: '',
            deviceSigningKey: uint8ArrayToBase64(deviceKeyPair.privateKey),
            devicePublicKey: uint8ArrayToBase64(deviceKeyPair.publicKey),
            deviceId,
            userId: response.device.userId ?? ''
          })

          deleteLinkingSession(sessionId)

          await fetchAndStoreAccountDevices()
          await resetSyncStateForNewDevice()
          void triggerPostSetupSync()

          return {
            success: true,
            device: {
              ...response.device,
              isCurrentDevice: true
            }
          }
        } catch (error) {
          console.error('[Sync] COMPLETE_LINKING error:', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Linking completion failed'
          }
        } finally {
          if (masterKey) await secureZero(masterKey)
          if (derivedKeys) {
            await secureZero(derivedKeys.vaultKey)
            await secureZero(derivedKeys.signingKeyPair.publicKey)
            await secureZero(derivedKeys.signingKeyPair.privateKey)
            await secureZero(derivedKeys.verifyKey)
          }
        }
      }
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.CANCEL_LINKING,
    createStringHandler((sessionId: string) => {
      deleteLinkingSession(sessionId)
      return { success: true }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_LINKING_STATUS,
    createValidatedHandler(
      z.object({ sessionId: z.string().uuid() }),
      async ({ sessionId }): Promise<GetLinkingStatusResponse> => {
        try {
          const storedTokens = await retrieveAuthTokens()
          const linkingSession = getLinkingSessionState(sessionId)

          if (linkingSession?.serverUrl && linkingSession?.linkingToken) {
            const client = createApiClientWithUrl(linkingSession.serverUrl)
            const response = await client.getLinkingStatusWithToken(sessionId, linkingSession.linkingToken)
            return {
              session: {
                id: response.id,
                userId: '',
                initiatorDeviceId: response.initiatorDeviceId,
                ephemeralPublicKey: response.ephemeralPublicKey,
                newDevicePublicKey: response.newDevicePublicKey,
                status: response.status,
                createdAt: response.createdAt,
                expiresAt: response.expiresAt,
                completedAt: response.completedAt
              }
            }
          }

          if (!storedTokens?.accessToken) {
            return { session: null }
          }

          const client = getSyncApiClient()
          const response = await client.getLinkingStatus(storedTokens.accessToken, sessionId)
          return {
            session: {
              id: response.id,
              userId: storedTokens.userId,
              initiatorDeviceId: response.initiatorDeviceId,
              ephemeralPublicKey: response.ephemeralPublicKey,
              newDevicePublicKey: response.newDevicePublicKey,
              status: response.status,
              createdAt: response.createdAt,
              expiresAt: response.expiresAt,
              completedAt: response.completedAt
            }
          }
        } catch (error) {
          console.error('[Sync] GET_LINKING_STATUS error:', error)
          return { session: null }
        }
      }
    )
  )

  // ============================================================================
  // Device Management
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_DEVICES,
    createHandler(
      (): GetDevicesResponse => ({
        devices: [],
        currentDeviceId: ''
      })
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.GET_CURRENT_DEVICE,
    createHandler(async (): Promise<Device | null> => {
      try {
        const hasKeys = await hasDeviceKeyPair()
        if (!hasKeys) {
          return null
        }

        const keyPair = await retrieveDeviceKeyPair()
        if (!keyPair) {
          return null
        }

        const platform = os.platform()
        const devicePlatform: DevicePlatform =
          platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'

        return {
          id: keyPair.deviceId,
          name: os.hostname(),
          platform: devicePlatform,
          osVersion: os.release(),
          appVersion: app.getVersion(),
          authPublicKey: uint8ArrayToBase64(keyPair.publicKey),
          linkedAt: Date.now(),
          isCurrentDevice: true
        }
      } catch (error) {
        console.error('[Sync] GET_CURRENT_DEVICE error:', error)
        return null
      }
    })
  )

  ipcMain.handle(
    SyncChannels.invoke.RENAME_DEVICE,
    createValidatedHandler(
      RenameDeviceRequestSchema,
      (): RenameDeviceResponse => createNotImplementedResponse()
    )
  )

  ipcMain.handle(
    SyncChannels.invoke.REVOKE_DEVICE,
    createValidatedHandler(
      RevokeDeviceRequestSchema,
      (): RevokeDeviceResponse => createNotImplementedResponse()
    )
  )

  // ============================================================================
  // User Account
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_USER,
    createHandler((): UserPublic | null => null)
  )

  ipcMain.handle(
    SyncChannels.invoke.DELETE_ACCOUNT,
    createHandler(() => createNotImplementedResponse())
  )

  // ============================================================================
  // Conflict Resolution
  // ============================================================================

  ipcMain.handle(
    SyncChannels.invoke.GET_CONFLICTS,
    createHandler((): GetConflictsResponse => ({ conflicts: [] }))
  )

  ipcMain.handle(
    SyncChannels.invoke.RESOLVE_CONFLICT,
    createValidatedHandler(
      ResolveConflictRequestSchema,
      (): ResolveConflictResponse => createNotImplementedResponse()
    )
  )

  console.log('[IPC] Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  Object.values(SyncChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })

  const engine = getSyncEngine()
  if (engine && decryptedItemListener) {
    engine.off('sync:item-decrypted', decryptedItemListener)
    decryptedItemListener = null
  }
  console.log('[IPC] Sync handlers unregistered')
}

// Exported for use by sync engine (T074+) to emit events to renderer
export { emitSyncEvent }
