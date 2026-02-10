import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import os from 'os'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@shared/db/schema/sync-devices'
import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@shared/contracts/crypto'
import {
  RequestOtpSchema,
  VerifyOtpSchema,
  ResendOtpSchema,
  SetupFirstDeviceSchema,
  ConfirmRecoveryPhraseSchema
} from '@shared/contracts/ipc-auth'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@shared/contracts/ipc-sync'

import {
  deriveKey,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateRecoveryPhrase,
  generateSalt,
  getDevicePublicKey,
  secureCleanup,
  storeKey,
  retrieveKey
} from '../crypto'
import { getDatabase } from '../database/client'
import { store } from '../store'
import { postToServer } from '../sync/http-client'

import { createValidatedHandler } from './validate'

// ============================================================================
// Types
// ============================================================================

interface VerifyOtpServerResponse {
  success: boolean
  userId: string
  isNewUser: boolean
  needsSetup: boolean
  setupToken: string
}

interface OAuthCallbackServerResponse {
  success: boolean
  userId: string
  isNewUser: boolean
  needsSetup: boolean
  setupToken: string
}

interface DeviceRegisterServerResponse {
  success: boolean
  deviceId: string
  accessToken: string
  refreshToken: string
}

interface FirstDeviceSetupResult {
  recoveryPhrase: string
  deviceId: string
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
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send(SYNC_EVENTS.OTP_DETECTED, { code: text })
      }
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
// Token Keychain Helpers
// ============================================================================

const storeToken = async (
  entry: (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES],
  token: string
): Promise<void> => {
  const encoded = new TextEncoder().encode(token)
  await storeKey(entry, encoded)
}

const retrieveToken = async (
  entry: (typeof KEYCHAIN_ENTRIES)[keyof typeof KEYCHAIN_ENTRIES]
): Promise<string | null> => {
  const encoded = await retrieveKey(entry)
  if (!encoded) return null
  return new TextDecoder().decode(encoded)
}

// ============================================================================
// Device Registration (T050c)
// ============================================================================

const PLATFORM_MAP: Record<string, string> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux'
}

const registerDevice = async (setupToken: string): Promise<DeviceRegisterServerResponse> => {
  await sodium.ready

  const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
  if (!signingKey) {
    throw new Error('Device signing key not found in keychain')
  }

  try {
    const publicKey = getDevicePublicKey(signingKey)
    const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)

    // Client-generated nonce: proves possession of private key for the submitted public key.
    // See server-side verifyDeviceChallenge comment for replay mitigation rationale.
    const nonce = crypto.randomUUID()
    const nonceBytes = new TextEncoder().encode(nonce)
    const signature = sodium.crypto_sign_detached(nonceBytes, signingKey)
    const signatureBase64 = sodium.to_base64(signature, sodium.base64_variants.ORIGINAL)

    const response = await postToServer<DeviceRegisterServerResponse>(
      '/auth/devices',
      {
        name: os.hostname(),
        platform: PLATFORM_MAP[process.platform] || 'linux',
        osVersion: os.release(),
        appVersion: app.getVersion(),
        authPublicKey: publicKeyBase64,
        challengeSignature: signatureBase64,
        challengeNonce: nonce
      },
      setupToken
    )

    await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, response.accessToken)
    await storeToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN, response.refreshToken)

    return response
  } finally {
    secureCleanup(signingKey)
  }
}

// ============================================================================
// First Device Setup Orchestration (T050f)
// ============================================================================

const performFirstDeviceSetup = async (setupToken: string): Promise<FirstDeviceSetupResult> => {
  const { phrase, seed } = await generateRecoveryPhrase()
  const salt = generateSalt()

  let masterKey: Uint8Array | undefined
  let vaultKey: Uint8Array | undefined
  let signingSecretKey: Uint8Array | undefined

  try {
    const { masterKey: mk, kdfSalt, keyVerifier } = await deriveMasterKey(seed, salt)
    masterKey = mk

    await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, masterKey)

    vaultKey = await deriveKey(masterKey, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    await storeKey(KEYCHAIN_ENTRIES.VAULT_KEY, vaultKey)

    const keyPair = await generateDeviceSigningKeyPair()
    signingSecretKey = keyPair.secretKey
    await storeKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY, signingSecretKey)

    const deviceResponse = await registerDevice(setupToken)

    const db = getDatabase()
    await db.insert(syncDevices).values({
      id: deviceResponse.deviceId,
      name: os.hostname(),
      platform: PLATFORM_MAP[process.platform] || 'linux',
      osVersion: os.release(),
      appVersion: app.getVersion(),
      linkedAt: new Date(),
      isCurrentDevice: true
    })

    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
    if (!accessToken) {
      throw new Error('Access token not found after device registration')
    }
    await postToServer('/auth/setup', { kdfSalt, keyVerifier }, accessToken)

    return {
      recoveryPhrase: phrase,
      deviceId: deviceResponse.deviceId
    }
  } finally {
    secureCleanup(seed, salt)
    if (masterKey) secureCleanup(masterKey)
    if (vaultKey) secureCleanup(vaultKey)
    if (signingSecretKey) secureCleanup(signingSecretKey)
  }
}

// ============================================================================
// Stub helper for not-yet-implemented handlers
// ============================================================================

const notImplemented = (channel: string) => (): never => {
  throw new Error(`${channel} not yet implemented`)
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerSyncHandlers(): void {
  // --- OTP Auth Handlers (T054, T055, T056) ---

  ipcMain.handle(
    SYNC_CHANNELS.AUTH_REQUEST_OTP,
    createValidatedHandler(RequestOtpSchema, async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/request', { email: input.email })
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.AUTH_VERIFY_OTP,
    createValidatedHandler(VerifyOtpSchema, async (input) => {
      const serverResponse = await postToServer<VerifyOtpServerResponse>('/auth/otp/verify', {
        email: input.email,
        code: input.code
      })

      stopOtpClipboardDetection()

      await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, serverResponse.setupToken)

      if (serverResponse.needsSetup) {
        const { recoveryPhrase, deviceId } = await performFirstDeviceSetup(
          serverResponse.setupToken
        )

        return {
          success: true,
          isNewUser: serverResponse.isNewUser,
          needsRecoverySetup: true,
          recoveryPhrase,
          deviceId
        }
      }

      return {
        success: true,
        isNewUser: serverResponse.isNewUser
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.AUTH_RESEND_OTP,
    createValidatedHandler(ResendOtpSchema, async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/resend', { email: input.email })
    })
  )

  // --- First Device Setup via OAuth (T057) ---

  ipcMain.handle(
    SYNC_CHANNELS.SETUP_FIRST_DEVICE,
    createValidatedHandler(SetupFirstDeviceSchema, async (input) => {
      const serverResponse = await postToServer<OAuthCallbackServerResponse>(
        `/auth/oauth/${input.provider}/callback`,
        { code: input.oauthToken, state: '' }
      )

      await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, serverResponse.setupToken)

      if (serverResponse.needsSetup) {
        const { recoveryPhrase, deviceId } = await performFirstDeviceSetup(
          serverResponse.setupToken
        )

        return {
          success: true,
          recoveryPhrase,
          deviceId
        }
      }

      return { success: true }
    })
  )

  // --- Recovery Phrase Confirmation (T062) ---

  ipcMain.handle(
    SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
    createValidatedHandler(ConfirmRecoveryPhraseSchema, (input) => {
      if (input.confirmed) {
        store.set('sync', { ...store.get('sync'), recoveryPhraseConfirmed: true })
      }
      return { success: true }
    })
  )

  // --- Not-yet-implemented handlers ---

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, notImplemented('GENERATE_LINKING_QR'))
  ipcMain.handle(SYNC_CHANNELS.LINK_VIA_QR, notImplemented('LINK_VIA_QR'))
  ipcMain.handle(SYNC_CHANNELS.LINK_VIA_RECOVERY, notImplemented('LINK_VIA_RECOVERY'))
  ipcMain.handle(SYNC_CHANNELS.APPROVE_LINKING, notImplemented('APPROVE_LINKING'))

  ipcMain.handle(SYNC_CHANNELS.GET_DEVICES, notImplemented('GET_DEVICES'))
  ipcMain.handle(SYNC_CHANNELS.REMOVE_DEVICE, notImplemented('REMOVE_DEVICE'))
  ipcMain.handle(SYNC_CHANNELS.RENAME_DEVICE, notImplemented('RENAME_DEVICE'))

  ipcMain.handle(SYNC_CHANNELS.GET_STATUS, notImplemented('GET_STATUS'))
  ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, notImplemented('TRIGGER_SYNC'))
  ipcMain.handle(SYNC_CHANNELS.GET_HISTORY, notImplemented('GET_HISTORY'))
  ipcMain.handle(SYNC_CHANNELS.GET_QUEUE_SIZE, notImplemented('GET_QUEUE_SIZE'))
  ipcMain.handle(SYNC_CHANNELS.PAUSE, notImplemented('PAUSE'))
  ipcMain.handle(SYNC_CHANNELS.RESUME, notImplemented('RESUME'))

  ipcMain.handle(SYNC_CHANNELS.UPLOAD_ATTACHMENT, notImplemented('UPLOAD_ATTACHMENT'))
  ipcMain.handle(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, notImplemented('GET_UPLOAD_PROGRESS'))
  ipcMain.handle(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, notImplemented('DOWNLOAD_ATTACHMENT'))
  ipcMain.handle(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS, notImplemented('GET_DOWNLOAD_PROGRESS'))

  console.log('[IPC] Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  stopOtpClipboardDetection()

  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP)

  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE)

  ipcMain.removeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY)
  ipcMain.removeHandler(SYNC_CHANNELS.APPROVE_LINKING)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_DEVICES)
  ipcMain.removeHandler(SYNC_CHANNELS.REMOVE_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.RENAME_DEVICE)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_STATUS)
  ipcMain.removeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_HISTORY)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)
  ipcMain.removeHandler(SYNC_CHANNELS.PAUSE)
  ipcMain.removeHandler(SYNC_CHANNELS.RESUME)

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)

  console.log('[IPC] Sync handlers unregistered')
}
