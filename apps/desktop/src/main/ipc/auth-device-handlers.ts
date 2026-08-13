import { clipboard, ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { RequestOtpSchema, VerifyOtpSchema, ResendOtpSchema } from '@memry/contracts/ipc-auth'
import { VerifyOtpResponseSchema, RecoveryDataResponseSchema } from '@memry/contracts/auth-api'
import {
  ApproveLinkingSchema,
  CompleteLinkingQrSchema,
  FinalizeVaultChoiceSchema,
  GetLinkingSasSchema,
  LINK_FAILURE_SETUP_SESSION_EXPIRED,
  LinkViaQrSchema,
  LinkViaRecoverySchema,
  PickVaultFolderSchema,
  RemoveDeviceSchema,
  RenameDeviceSchema
} from '@memry/contracts/ipc-devices'
import type { LinkFailureCode } from '@memry/contracts/ipc-devices'
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
import {
  deleteFromServer,
  getFromServer,
  patchToServer,
  postToServer,
  SyncServerError
} from '../sync/http-client'
import { persistKeysAndRegisterDevice } from '../sync/device-registration'
import {
  approveDeviceLinking,
  completeLinkingQr,
  finalizeVaultChoice,
  getLinkingVerificationCode,
  initiateDeviceLinking,
  linkViaQr
} from '../sync/linking-service'
import { getValidAccessToken, storeToken } from '../sync/token-manager'
import { ensureLiveSetupToken, getSetupDevicePublicKey } from '../sync/setup-token'
import { createLogger } from '../lib/logger'
import { registerCommand } from './lib/register-command'
import { getMainI18n } from '../lib/main-i18n'

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
// Setup-token failures
// ============================================================================

/**
 * The setup token minted at sign-in is valid for five minutes and is consumed
 * by the first device registration. Finishing a reinstall takes longer than
 * that whenever the user has to go and find their 24-word recovery phrase, so
 * the server answers 401 and its wording — "Invalid setup token", "Setup token
 * already used" — used to reach the user verbatim (issue #1202). Nobody can
 * act on a message about an artifact they never saw.
 *
 * Every setup-token rejection is translated into one sentence about signing in
 * again, and logged with the (non-sensitive) reason so a diagnostic report can
 * separate "expired while the user was reading" from "never persisted". Token
 * contents are never logged.
 */
function isSetupTokenRejection(err: unknown): boolean {
  return err instanceof SyncServerError && err.statusCode === 401
}

function setupSessionExpiredMessage(): string {
  return getMainI18n().t('errors:auth.setupSessionExpired')
}

/**
 * The failure envelope for a dead setup token: the translated sentence for the
 * user plus the stable code the renderer branches on. The message is localized
 * here, so it is display text only — see `LinkFailureCode`.
 */
function setupSessionExpiredResult(message = setupSessionExpiredMessage()): {
  success: false
  error: string
  errorCode: LinkFailureCode
} {
  return {
    success: false,
    error: message,
    errorCode: LINK_FAILURE_SETUP_SESSION_EXPIRED
  }
}

function logSetupTokenFailure(
  stage: 'recovery-info' | 'device-register' | 'first-device-setup' | 'link-via-qr',
  reason: 'absent' | 'locally-expired' | 'rejected',
  err?: unknown
): void {
  logger.warn('Setup token unusable during account setup', {
    stage,
    reason,
    statusCode: err instanceof SyncServerError ? err.statusCode : undefined,
    serverError: err instanceof SyncServerError ? err.serverError : undefined
  })
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
    'errors:auth.requestOtpFailed'
  )

  registerCommand(
    SYNC_CHANNELS.AUTH_VERIFY_OTP,
    VerifyOtpSchema,
    async (input) => {
      const raw = await postToServer<unknown>('/auth/otp/verify', {
        email: input.email,
        code: input.code,
        // Committing this device's key here is what lets the setup token be
        // renewed later, when the user comes back with their recovery phrase.
        devicePublicKey: await getSetupDevicePublicKey()
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
    'errors:auth.verifyOtpFailed'
  )

  ipcMain.handle(SYNC_CHANNELS.SETUP_NEW_ACCOUNT, async () => {
    const setupToken = await ensureLiveSetupToken()
    if (!setupToken) {
      logSetupTokenFailure('first-device-setup', 'absent')
      return { success: false, error: setupSessionExpiredMessage() }
    }

    try {
      const { deviceId } = await performFirstDeviceSetup(setupToken)
      return { success: true, deviceId }
    } catch (err) {
      if (!isSetupTokenRejection(err)) throw err
      logSetupTokenFailure('first-device-setup', 'rejected', err)
      return { success: false, error: setupSessionExpiredMessage() }
    }
  })

  registerCommand(
    SYNC_CHANNELS.AUTH_RESEND_OTP,
    ResendOtpSchema,
    async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/resend', { email: input.email })
    },
    'errors:auth.resendOtpFailed'
  )

  // --- Device Linking Handlers ---

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, async () => {
    const accessToken = await getValidAccessToken()
    if (!accessToken) throw new Error(getMainI18n().t('errors:auth.notAuthenticated'))
    return initiateDeviceLinking(accessToken)
  })

  registerCommand(
    SYNC_CHANNELS.LINK_VIA_QR,
    LinkViaQrSchema,
    async (input) => {
      const token = input.oauthToken || (await ensureLiveSetupToken())
      if (!token) {
        // Same class of failure as the recovery path, on the QR surface: the
        // sign-in that minted the setup token ran out. "No auth token available
        // for device linking" named an artifact the user never saw (#1202).
        logSetupTokenFailure('link-via-qr', 'absent')
        return setupSessionExpiredResult(getMainI18n().t('errors:auth.setupSessionExpiredLinking'))
      }
      return linkViaQr(input.qrData, token)
    },
    'errors:auth.linkDeviceQrFailed'
  )

  registerCommand(
    SYNC_CHANNELS.COMPLETE_LINKING_QR,
    CompleteLinkingQrSchema,
    async (input) => {
      return completeLinkingQr(input.sessionId)
    },
    'errors:auth.completeLinkingFailed'
  )

  registerCommand(
    SYNC_CHANNELS.FINALIZE_VAULT_CHOICE,
    FinalizeVaultChoiceSchema,
    async (input) => finalizeVaultChoice(input),
    'errors:auth.finalizeVaultChoiceFailed'
  )

  registerCommand(
    SYNC_CHANNELS.PICK_VAULT_FOLDER,
    PickVaultFolderSchema,
    async () => {
      const { pickVaultFolder } = await import('../vault')
      return { path: await pickVaultFolder() }
    },
    'errors:auth.pickFolderFailed'
  )

  registerCommand(
    SYNC_CHANNELS.LINK_VIA_RECOVERY,
    LinkViaRecoverySchema,
    async (input) => {
      if (!validateRecoveryPhrase(input.recoveryPhrase)) {
        return { success: false, error: getMainI18n().t('errors:auth.invalidRecoveryPhraseFormat') }
      }

      // Finding a 24-word recovery phrase routinely outlasts the setup token's
      // five minutes, so a token that ran out is renewed in place here rather
      // than dead-ending the reinstall (#1202). Null means renewal was not
      // possible either, which is where "sign in again" takes over.
      const setupToken = await ensureLiveSetupToken()
      if (!setupToken) {
        logSetupTokenFailure('recovery-info', 'absent')
        return setupSessionExpiredResult()
      }

      let rawRecovery: unknown
      try {
        rawRecovery = await getFromServer<unknown>('/auth/recovery-info', setupToken)
      } catch (err) {
        if (!isSetupTokenRejection(err)) throw err
        logSetupTokenFailure('recovery-info', 'rejected', err)
        return setupSessionExpiredResult()
      }
      const recoveryInfo = RecoveryDataResponseSchema.parse(rawRecovery)

      const derived = await recoverMasterKeyFromPhrase(input.recoveryPhrase, recoveryInfo.kdfSalt)

      let signingSecretKey: Uint8Array | undefined

      try {
        if (!validateKeyVerifier(derived.keyVerifier, recoveryInfo.keyVerifier)) {
          return { success: false, error: getMainI18n().t('errors:auth.recoveryPhraseMismatch') }
        }

        const keyPair = await getOrCreateSigningKeyPair()
        signingSecretKey = keyPair.secretKey

        try {
          const deviceId = await persistKeysAndRegisterDevice(
            derived.masterKey,
            signingSecretKey,
            setupToken,
            derived.kdfSalt,
            derived.keyVerifier,
            true
          )

          return { success: true, deviceId }
        } catch (err) {
          if (!isSetupTokenRejection(err)) throw err
          logSetupTokenFailure('device-register', 'rejected', err)
          return setupSessionExpiredResult()
        }
      } finally {
        secureCleanup(derived.masterKey)
        if (signingSecretKey) secureCleanup(signingSecretKey)
      }
    },
    'errors:auth.linkRecoveryPhraseFailed'
  )

  registerCommand(
    SYNC_CHANNELS.APPROVE_LINKING,
    ApproveLinkingSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error(getMainI18n().t('errors:auth.notAuthenticated'))
      return approveDeviceLinking(input.sessionId, accessToken)
    },
    'errors:auth.approveLinkingFailed'
  )

  registerCommand(
    SYNC_CHANNELS.GET_LINKING_SAS,
    GetLinkingSasSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error(getMainI18n().t('errors:auth.notAuthenticated'))
      return getLinkingVerificationCode(input.sessionId, accessToken)
    },
    'errors:auth.fetchSasCodeFailed'
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
          return { success: false, error: getMainI18n().t('errors:auth.cannotRemoveCurrentDevice') }
        }
      }

      const accessToken = await getValidAccessToken()
      if (!accessToken)
        return { success: false, error: getMainI18n().t('errors:auth.notAuthenticated') }

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
    'errors:auth.removeDeviceFailed'
  )

  registerCommand(
    SYNC_CHANNELS.RENAME_DEVICE,
    RenameDeviceSchema,
    async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken)
        return { success: false, error: getMainI18n().t('errors:auth.notAuthenticated') }

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
    'errors:auth.renameDeviceFailed'
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
