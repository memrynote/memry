import { clipboard, ipcMain } from 'electron'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { RequestOtpSchema, VerifyOtpSchema, ResendOtpSchema } from '@memry/contracts/ipc-auth'
import { VerifyOtpResponseSchema, RecoveryDataResponseSchema } from '@memry/contracts/auth-api'
import {
  ApproveLinkingSchema,
  CompleteLinkingQrSchema,
  FinalizeVaultChoiceSchema,
  GetLinkingSasSchema,
  LinkViaQrSchema,
  LinkViaRecoverySchema,
  PickVaultFolderSchema,
  RemoveDeviceSchema,
  RenameDeviceSchema
} from '@memry/contracts/ipc-devices'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'

import { eq } from 'drizzle-orm'

import {
  deriveMasterKey,
  generateRecoveryPhrase,
  generateSalt,
  getOrCreateSigningKeyPair,
  recoverMasterKeyFromPhrase,
  secureCleanup,
  validateKeyVerifier,
  validateRecoveryPhrase
} from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { deleteFromServer, getFromServer, patchToServer, postToServer } from '../sync/http-client'
import { persistKeysAndRegisterDevice } from '../sync/device-registration'
import {
  approveDeviceLinking,
  completeLinkingQr,
  finalizeVaultChoice,
  getLinkingVerificationCode,
  initiateDeviceLinking,
  linkViaQr
} from '../sync/linking-service'
import { getValidAccessToken, retrieveToken, storeToken } from '../sync/token-manager'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { registerCommand } from './lib/register-command'

const logger = createLogger('IPC:Sync:Device')

// ============================================================================
// Types
// ============================================================================

interface FirstDeviceSetupResult {
  deviceId: string
}

interface LocalDeviceRow {
  id: string
  name: string
  platform: string
  linkedAt: Date
  lastSyncAt: Date | null
  isCurrentDevice: boolean
}

interface RemoteDeviceRow {
  id: string
  name: string
  platform: string
  createdAt: number
  lastSyncAt: number | null
}

function toTimestampMs(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value < 10_000_000_000 ? value * 1000 : value
}

function parseRemoteDevices(raw: unknown): RemoteDeviceRow[] | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { devices?: unknown }).devices)) {
    return null
  }

  const devices: RemoteDeviceRow[] = []
  for (const device of (raw as { devices: unknown[] }).devices) {
    if (!device || typeof device !== 'object') return null
    const row = device as Record<string, unknown>
    if (
      typeof row.id !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.platform !== 'string' ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt) ||
      (row.lastSyncAt !== null &&
        row.lastSyncAt !== undefined &&
        (typeof row.lastSyncAt !== 'number' || !Number.isFinite(row.lastSyncAt)))
    ) {
      return null
    }

    devices.push({
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.createdAt,
      lastSyncAt: row.lastSyncAt ?? null
    })
  }

  return devices
}

function mapLocalDevice(row: LocalDeviceRow) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as 'macos' | 'windows' | 'linux' | 'ios' | 'android',
    linkedAt: row.linkedAt.getTime(),
    lastSyncAt: row.lastSyncAt?.getTime(),
    isCurrentDevice: row.isCurrentDevice
  }
}

// ============================================================================
// Pending Recovery Phrase
// ============================================================================

let pendingRecoveryPhrase: string | null = null

export function getPendingRecoveryPhrase(): string | null {
  return pendingRecoveryPhrase
}

export function clearPendingRecoveryPhrase(): void {
  pendingRecoveryPhrase = null
}

export async function performFirstDeviceSetup(setupToken: string): Promise<FirstDeviceSetupResult> {
  const { phrase, seed } = await generateRecoveryPhrase()
  const salt = generateSalt()

  let masterKey: Uint8Array | undefined
  let signingSecretKey: Uint8Array | undefined

  try {
    const { masterKey: mk, kdfSalt, keyVerifier } = await deriveMasterKey(seed, salt)
    masterKey = mk

    const keyPair = await getOrCreateSigningKeyPair()
    signingSecretKey = keyPair.secretKey

    const deviceId = await persistKeysAndRegisterDevice(
      masterKey,
      signingSecretKey,
      setupToken,
      kdfSalt,
      keyVerifier,
      false,
      true
    )

    pendingRecoveryPhrase = phrase
    store.set('sync', { ...store.get('sync'), recoveryPhraseConfirmed: false })
    return { deviceId }
  } finally {
    secureCleanup(seed, salt)
    if (masterKey) secureCleanup(masterKey)
    if (signingSecretKey) secureCleanup(signingSecretKey)
  }
}

// ============================================================================
// OTP Clipboard Detection State
// ============================================================================

let otpClipboardInterval: ReturnType<typeof setInterval> | null = null
let otpClipboardTimeout: ReturnType<typeof setTimeout> | null = null
let lastClipboardValue = ''

const OTP_PATTERN = /^\d{6}$/
const OTP_CLIPBOARD_POLL_MS = 1000
const OTP_CLIPBOARD_TIMEOUT_MS = 10 * 60 * 1000

const startOtpClipboardDetection = (): void => {
  stopOtpClipboardDetection()

  lastClipboardValue = clipboard.readText()

  otpClipboardInterval = setInterval(() => {
    const text = clipboard.readText().trim()
    if (text === lastClipboardValue) return
    lastClipboardValue = text

    if (OTP_PATTERN.test(text)) {
      broadcastToAllWindows(SYNC_EVENTS.OTP_DETECTED, { code: text })
    }
  }, OTP_CLIPBOARD_POLL_MS)

  otpClipboardTimeout = setTimeout(() => {
    stopOtpClipboardDetection()
  }, OTP_CLIPBOARD_TIMEOUT_MS)
}

const stopOtpClipboardDetection = (): void => {
  if (otpClipboardInterval) {
    clearInterval(otpClipboardInterval)
    otpClipboardInterval = null
  }
  if (otpClipboardTimeout) {
    clearTimeout(otpClipboardTimeout)
    otpClipboardTimeout = null
  }
}

// ============================================================================
// State cleanup (composed by sync-handlers' clearInMemoryAuthState)
// ============================================================================

export function clearAuthDeviceState(): void {
  clearPendingRecoveryPhrase()
  stopOtpClipboardDetection()
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerAuthDeviceHandlers(): void {
  // --- OTP Auth Handlers (T054, T055, T056) ---

  registerCommand(
    SYNC_CHANNELS.AUTH_REQUEST_OTP,
    RequestOtpSchema,
    async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/request', { email: input.email })
    },
    'Failed to request OTP'
  )

  registerCommand(
    SYNC_CHANNELS.AUTH_VERIFY_OTP,
    VerifyOtpSchema,
    async (input) => {
      const raw = await postToServer<unknown>('/auth/otp/verify', {
        email: input.email,
        code: input.code
      })
      const serverResponse = VerifyOtpResponseSchema.parse(raw)

      stopOtpClipboardDetection()

      store.set('sync', { ...store.get('sync'), email: input.email })

      if (serverResponse.setupToken) {
        await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, serverResponse.setupToken)
      }

      return {
        success: true,
        isNewUser: serverResponse.isNewUser ?? false,
        needsSetup: serverResponse.needsSetup ?? false,
        needsRecoveryInput: !(serverResponse.needsSetup ?? false)
      }
    },
    'Failed to verify OTP'
  )

  ipcMain.handle(SYNC_CHANNELS.SETUP_NEW_ACCOUNT, async () => {
    const setupToken = await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN)
    if (!setupToken) {
      return { success: false, error: 'Session expired. Please sign in again.' }
    }

    const { deviceId } = await performFirstDeviceSetup(setupToken)
    return { success: true, deviceId }
  })

  registerCommand(
    SYNC_CHANNELS.AUTH_RESEND_OTP,
    ResendOtpSchema,
    async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/resend', { email: input.email })
    },
    'Failed to resend OTP'
  )

  // --- Device Linking Handlers ---

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, async () => {
    const accessToken = await getValidAccessToken()
    if (!accessToken) throw new Error('Not authenticated')
    return initiateDeviceLinking(accessToken)
  })

  registerCommand(
    SYNC_CHANNELS.LINK_VIA_QR,
    LinkViaQrSchema,
    async (input) => {
      const token = input.oauthToken || (await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN))
      if (!token) throw new Error('No auth token available for device linking')
      return linkViaQr(input.qrData, token)
    },
    'Failed to link device via QR'
  )

  registerCommand(
    SYNC_CHANNELS.COMPLETE_LINKING_QR,
    CompleteLinkingQrSchema,
    async (input) => {
      return completeLinkingQr(input.sessionId)
    },
    'Failed to complete linking'
  )

  registerCommand(
    SYNC_CHANNELS.FINALIZE_VAULT_CHOICE,
    FinalizeVaultChoiceSchema,
    async (input) => finalizeVaultChoice(input),
    'Failed to finalize vault choice'
  )

  registerCommand(
    SYNC_CHANNELS.PICK_VAULT_FOLDER,
    PickVaultFolderSchema,
    async () => {
      const { pickVaultFolder } = await import('../vault')
      return { path: await pickVaultFolder() }
    },
    'Failed to pick folder'
  )

  registerCommand(
    SYNC_CHANNELS.LINK_VIA_RECOVERY,
    LinkViaRecoverySchema,
    async (input) => {
      if (!validateRecoveryPhrase(input.recoveryPhrase)) {
        return { success: false, error: 'Invalid recovery phrase format' }
      }

      const setupToken = await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN)
      if (!setupToken) {
        return { success: false, error: 'Session expired. Please sign in again.' }
      }

      const rawRecovery = await getFromServer<unknown>('/auth/recovery-info', setupToken)
      const recoveryInfo = RecoveryDataResponseSchema.parse(rawRecovery)

      const derived = await recoverMasterKeyFromPhrase(input.recoveryPhrase, recoveryInfo.kdfSalt)

      let signingSecretKey: Uint8Array | undefined

      try {
        if (!validateKeyVerifier(derived.keyVerifier, recoveryInfo.keyVerifier)) {
          return { success: false, error: 'Recovery phrase does not match. Please try again.' }
        }

        const keyPair = await getOrCreateSigningKeyPair()
        signingSecretKey = keyPair.secretKey

        const deviceId = await persistKeysAndRegisterDevice(
          derived.masterKey,
          signingSecretKey,
          setupToken,
          derived.kdfSalt,
          derived.keyVerifier,
          true
        )

        return { success: true, deviceId }
      } finally {
        secureCleanup(derived.masterKey)
        if (signingSecretKey) secureCleanup(signingSecretKey)
      }
    },
    'Failed to link via recovery phrase'
  )

  registerCommand(
    SYNC_CHANNELS.APPROVE_LINKING,
    ApproveLinkingSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error('Not authenticated')
      return approveDeviceLinking(input.sessionId, accessToken)
    },
    'Failed to approve linking'
  )

  registerCommand(
    SYNC_CHANNELS.GET_LINKING_SAS,
    GetLinkingSasSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error('Not authenticated')
      return getLinkingVerificationCode(input.sessionId, accessToken)
    },
    'Failed to fetch SAS code'
  )

  // --- Device Management Handlers ---

  ipcMain.handle(SYNC_CHANNELS.GET_DEVICES, async () => {
    if (!isDatabaseInitialized()) {
      return { devices: [], email: undefined, needsRecoveryConfirmation: false }
    }
    const db = getDatabase()
    const rows = (await db.select().from(syncDevices)) as LocalDeviceRow[]
    const syncData = store.get('sync')
    const needsRecoveryConfirmation = syncData.recoveryPhraseConfirmed === false
    const currentDeviceId = rows.find((device) => device.isCurrentDevice)?.id
    const accessToken = await getValidAccessToken()

    if (accessToken) {
      try {
        const remoteResponse = await getFromServer<unknown>('/devices', accessToken)
        const remoteDevices = parseRemoteDevices(remoteResponse)
        if (remoteDevices) {
          return {
            devices: remoteDevices.map((device) => ({
              id: device.id,
              name: device.name,
              platform: device.platform as 'macos' | 'windows' | 'linux' | 'ios' | 'android',
              linkedAt: toTimestampMs(device.createdAt)!,
              lastSyncAt: toTimestampMs(device.lastSyncAt),
              isCurrentDevice: device.id === currentDeviceId
            })),
            email: syncData.email,
            needsRecoveryConfirmation
          }
        }

        logger.warn('Invalid remote device list response; using local device cache')
      } catch (err) {
        logger.warn('Failed to refresh remote device list; using local device cache', err)
      }
    }

    const devices = rows.map(mapLocalDevice)
    return { devices, email: syncData.email, needsRecoveryConfirmation }
  })

  registerCommand(
    SYNC_CHANNELS.REMOVE_DEVICE,
    RemoveDeviceSchema,
    async (input) => {
      if (isDatabaseInitialized()) {
        const db = getDatabase()
        const current = db
          .select({ id: syncDevices.id })
          .from(syncDevices)
          .where(eq(syncDevices.isCurrentDevice, true))
          .get()
        if (current && current.id === input.deviceId) {
          return { success: false, error: 'Cannot remove the current device' }
        }
      }

      const accessToken = await getValidAccessToken()
      if (!accessToken) return { success: false, error: 'Not authenticated' }

      try {
        await deleteFromServer(`/devices/${input.deviceId}`, accessToken)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('404')) {
          return { success: false, error: `Server error: ${msg}` }
        }
        logger.warn(`Device ${input.deviceId} already gone on server (404), cleaning up locally`)
      }

      if (isDatabaseInitialized()) {
        const db = getDatabase()
        db.delete(syncDevices).where(eq(syncDevices.id, input.deviceId)).run()
      }

      logger.info(`Device removed: ${input.deviceId}`)
      return { success: true }
    },
    'Failed to remove device'
  )

  registerCommand(
    SYNC_CHANNELS.RENAME_DEVICE,
    RenameDeviceSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) return { success: false, error: 'Not authenticated' }

      try {
        await patchToServer(`/devices/${input.deviceId}`, { name: input.newName }, accessToken)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Server error: ${msg}` }
      }

      if (isDatabaseInitialized()) {
        const db = getDatabase()
        db.update(syncDevices)
          .set({ name: input.newName })
          .where(eq(syncDevices.id, input.deviceId))
          .run()
      }

      broadcastToAllWindows(SYNC_EVENTS.DEVICE_RENAMED, {
        deviceId: input.deviceId,
        name: input.newName
      })

      logger.info(`Device renamed: ${input.deviceId} → ${input.newName}`)
      return { success: true }
    },
    'Failed to rename device'
  )

  logger.debug('Auth/Device handlers registered')
}

export function unregisterAuthDeviceHandlers(): void {
  stopOtpClipboardDetection()

  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_NEW_ACCOUNT)

  ipcMain.removeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.COMPLETE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY)
  ipcMain.removeHandler(SYNC_CHANNELS.APPROVE_LINKING)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_LINKING_SAS)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_DEVICES)
  ipcMain.removeHandler(SYNC_CHANNELS.REMOVE_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.RENAME_DEVICE)

  pendingRecoveryPhrase = null
}
