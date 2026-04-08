import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'os'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import {
  RequestOtpSchema,
  VerifyOtpSchema,
  ResendOtpSchema,
  InitOAuthSchema,
  SetupFirstDeviceSchema,
  ConfirmRecoveryPhraseSchema
} from '@memry/contracts/ipc-auth'
import {
  DeviceRegisterResponseSchema,
  OAuthCallbackResponseSchema,
  RecoveryDataResponseSchema,
  VerifyOtpResponseSchema
} from '@memry/contracts/auth-api'
import type { DeviceRegisterResponse } from '@memry/contracts/auth-api'
import {
  ApproveLinkingSchema,
  CompleteLinkingQrSchema,
  GetLinkingSasSchema,
  LinkViaQrSchema,
  LinkViaRecoverySchema,
  RemoveDeviceSchema,
  RenameDeviceSchema
} from '@memry/contracts/ipc-devices'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  GetHistorySchema,
  StorageBreakdownResult,
  UpdateSyncedSettingSchema
} from '@memry/contracts/ipc-sync-ops'
import {
  UploadAttachmentSchema,
  GetUploadProgressSchema,
  DownloadAttachmentSchema,
  GetDownloadProgressSchema
} from '@memry/contracts/ipc-attachments'
import path from 'node:path'
import { AttachmentSyncService, type TransferProgress } from '../sync/attachments'
import { UploadQueue } from '../sync/upload-queue'
import { attachmentEvents } from '../sync/attachment-events'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import {
  approveDeviceLinking,
  completeLinkingQr,
  getLinkingVerificationCode,
  initiateDeviceLinking,
  linkViaQr
} from '../sync/linking-service'
import { getSettingsSyncManager } from '../sync/settings-sync'
import { getStatus as getVaultStatus } from '../vault/index'
import { syncHistory } from '@memry/db-schema/schema/sync-history'

import { eq, desc, count, inArray } from 'drizzle-orm'

import type { SyncEngine } from '../sync/engine'

import {
  deleteKey,
  deriveMasterKey,
  generateRecoveryPhrase,
  generateSalt,
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  getOrDeriveVaultKey,
  recoverMasterKeyFromPhrase,
  secureCleanup,
  storeKey,
  retrieveKey,
  validateKeyVerifier,
  validateRecoveryPhrase
} from '../crypto'
import { getDatabase, getIndexDatabase, isDatabaseInitialized } from '../database/client'
import { updateNoteCache } from '@main/database/queries/notes'
import { updateNoteMetadata } from '@memry/storage-data'
import { store } from '../store'
import { deleteFromServer, getFromServer, patchToServer, postToServer } from '../sync/http-client'

import { createLogger } from '../lib/logger'
import { createValidatedHandler, withErrorHandler } from './validate'
import { getNetworkMonitor, getSyncEngine, startSyncRuntime } from '../sync/runtime'
import { teardownSession } from '../sync/session-teardown'
import {
  getValidAccessToken,
  retrieveToken,
  storeToken,
  extractJtiFromToken,
  scheduleTokenRefresh,
  cancelTokenRefresh,
  refreshAccessToken,
  ACCESS_TOKEN_EXPIRY_SECONDS
} from '../sync/token-manager'

const logger = createLogger('IPC:Sync')

// ============================================================================
// Types
// ============================================================================

interface FirstDeviceSetupResult {
  deviceId: string
}

// ============================================================================
// OTP Clipboard Detection State
// ============================================================================

let pendingRecoveryPhrase: string | null = null

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
// PKCE State (T072, T072a)
// ============================================================================

interface OAuthSession {
  state: string
  redirectUri: string
  createdAt: number
}

const oauthSessions = new Map<string, OAuthSession>()
const OAUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000
let activeLoopbackServer: http.Server | null = null

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'

const cleanExpiredOAuthSessions = (): void => {
  const now = Date.now()
  for (const [state, session] of oauthSessions) {
    if (now - session.createdAt > OAUTH_SESSION_TIMEOUT_MS) {
      oauthSessions.delete(state)
    }
  }
}

const parseSyncHistoryDetails = (details: string): unknown => {
  try {
    return JSON.parse(details) as unknown
  } catch {
    return details
  }
}

const consumeOAuthSession = (state: string): OAuthSession => {
  const session = oauthSessions.get(state)
  if (!session) {
    throw new Error('Invalid or expired OAuth state parameter')
  }
  if (Date.now() - session.createdAt > OAUTH_SESSION_TIMEOUT_MS) {
    oauthSessions.delete(state)
    throw new Error('OAuth session expired. Please try again.')
  }
  oauthSessions.delete(state)
  return session
}

const shutdownLoopbackServer = (): void => {
  if (activeLoopbackServer) {
    activeLoopbackServer.close()
    activeLoopbackServer = null
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Memry</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="c"><h1>Signed in</h1><p>You can close this tab and return to Memry.</p></div></body></html>`

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Memry</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="c"><h1>Authentication failed</h1><p>Authentication was cancelled. You can close this window.</p></div></body></html>`

const startLoopbackServer = (): Promise<{ server: http.Server; port: number }> => {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        return reject(new Error('Failed to bind loopback server'))
      }
      resolve({ server, port: addr.port })
    })
    server.on('error', reject)
  })
}

// ============================================================================
// Device Registration (T050c)
// ============================================================================

const PLATFORM_MAP: Record<string, string> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux'
}

const registerDevice = async (
  setupToken: string,
  signingSecretKey: Uint8Array
): Promise<DeviceRegisterResponse> => {
  await sodium.ready

  const publicKey = getDevicePublicKey(signingSecretKey)
  const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)

  const nonce = crypto.randomUUID()
  const jti = extractJtiFromToken(setupToken)
  const challengePayload = `${nonce}:${jti}`
  const payloadBytes = new TextEncoder().encode(challengePayload)
  const signature = sodium.crypto_sign_detached(payloadBytes, signingSecretKey)
  const signatureBase64 = sodium.to_base64(signature, sodium.base64_variants.ORIGINAL)

  const raw = await postToServer<unknown>(
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
  const response = DeviceRegisterResponseSchema.parse(raw)

  if (!response.accessToken || !response.refreshToken || !response.deviceId) {
    throw new Error(response.error ?? 'Device registration failed: missing tokens')
  }

  await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, response.accessToken)
  await storeToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN, response.refreshToken)
  scheduleTokenRefresh(ACCESS_TOKEN_EXPIRY_SECONDS)

  return response
}

// ============================================================================
// First Device Setup Orchestration (T050f)
// ============================================================================

export const persistKeysAndRegisterDevice = async (
  masterKey: Uint8Array,
  signingSecretKey: Uint8Array,
  setupToken: string,
  kdfSalt: string,
  keyVerifier: string,
  skipSetup?: boolean,
  skipActivation?: boolean
): Promise<string> => {
  await storeKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY, signingSecretKey)

  let deviceResponse: DeviceRegisterResponse & { deviceId: string }
  try {
    const raw = await registerDevice(setupToken, signingSecretKey)
    deviceResponse = raw as DeviceRegisterResponse & { deviceId: string }
  } catch (err) {
    await deleteKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => {})
    throw err
  }

  if (!skipSetup) {
    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
    if (!accessToken) {
      throw new Error('Access token not found after device registration')
    }

    try {
      await postToServer('/auth/setup', { kdfSalt, keyVerifier }, accessToken)
    } catch (err) {
      logger.error(
        'Failed to POST /auth/setup after device registration — recoverable on retry',
        err
      )
    }
  }

  try {
    await storeKey(KEYCHAIN_ENTRIES.MASTER_KEY, masterKey)
  } catch (keychainErr) {
    logger.error('Failed to store master key in keychain after device registration', keychainErr)

    const accessToken = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN).catch(() => null)
    if (accessToken) {
      try {
        await deleteFromServer(`/auth/devices/${deviceResponse.deviceId}`, accessToken)
      } catch (deregErr) {
        logger.error(
          'Failed to deregister device after keychain write failure — orphaned device on server',
          deregErr
        )
      }
    }

    await deleteKey(KEYCHAIN_ENTRIES.ACCESS_TOKEN).catch(() => {})
    await deleteKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN).catch(() => {})
    await deleteKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => {})

    throw new Error(
      'Failed to save encryption key securely. Device registration has been rolled back. Please try again.'
    )
  }

  const db = getDatabase()
  const pubKey = getDevicePublicKey(signingSecretKey)
  const pubKeyBase64 = sodium.to_base64(pubKey, sodium.base64_variants.ORIGINAL)

  db.transaction((tx) => {
    tx.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true)).run()
    tx.delete(syncState)
      .where(inArray(syncState.key, ['lastCursor', 'lastSyncAt', 'initialSeedDone', 'syncPaused']))
      .run()
    tx.insert(syncDevices)
      .values({
        id: deviceResponse.deviceId,
        name: os.hostname(),
        platform: PLATFORM_MAP[process.platform] || 'linux',
        osVersion: os.release(),
        appVersion: app.getVersion(),
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: pubKeyBase64
      })
      .run()
  })

  if (!skipActivation) {
    const engine = getSyncEngine()
    if (engine) {
      void engine.activate()
    } else {
      void startSyncRuntime()
    }
  }

  return deviceResponse.deviceId
}

const performFirstDeviceSetup = async (setupToken: string): Promise<FirstDeviceSetupResult> => {
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
    return { deviceId }
  } finally {
    secureCleanup(seed, salt)
    if (masterKey) secureCleanup(masterKey)
    if (signingSecretKey) secureCleanup(signingSecretKey)
  }
}

// ============================================================================
// Startup Integrity Check
// ============================================================================

export async function checkSyncIntegrity(): Promise<void> {
  if (!isDatabaseInitialized()) {
    logger.debug('Skipping sync integrity check — no vault open')
    return
  }
  try {
    const db = getDatabase()
    const currentDevice = db
      .select()
      .from(syncDevices)
      .where(eq(syncDevices.isCurrentDevice, true))
      .get()

    if (!currentDevice) return

    const masterKey = await retrieveKey(KEYCHAIN_ENTRIES.MASTER_KEY).catch(() => null)
    if (!masterKey) {
      logger.error(
        'Detected orphaned device registration — master key missing from keychain. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState()
      return
    }

    const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => null)
    if (!signingKey) {
      logger.error(
        'Signing key missing from keychain but device registered. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState()
      return
    }

    const derivedPubKey = getDevicePublicKey(signingKey)
    secureCleanup(signingKey)
    const derivedPubKeyB64 = sodium.to_base64(derivedPubKey, sodium.base64_variants.ORIGINAL)

    if (currentDevice.signingPublicKey && currentDevice.signingPublicKey !== derivedPubKeyB64) {
      logger.warn(
        'Signing key mismatch: DB public key does not match keychain-derived key. ' +
          'Self-healing by updating DB to match keychain (keychain is authority).',
        { deviceId: currentDevice.id }
      )
      db.update(syncDevices)
        .set({ signingPublicKey: derivedPubKeyB64 })
        .where(eq(syncDevices.id, currentDevice.id))
        .run()
      return
    }
  } catch (err) {
    logger.error('Sync integrity check failed', err)
  }
}

async function cleanupLocalSyncState(): Promise<void> {
  await teardownSession('integrity')
}

// ============================================================================
// Attachment Service (lazy singleton)
// ============================================================================

let attachmentService: AttachmentSyncService | null = null
let uploadQueue: UploadQueue | null = null

const getOrCreateUploadQueue = (): UploadQueue | null => {
  if (uploadQueue) return uploadQueue
  const service = getOrCreateAttachmentService()
  if (!service) return null
  uploadQueue = new UploadQueue(
    service.uploadAttachment.bind(service),
    getNetworkMonitor() ?? undefined
  )
  return uploadQueue
}

const broadcastUploadProgress = (progress: TransferProgress): void => {
  const percent =
    progress.totalChunks > 0
      ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
      : 0
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SYNC_EVENTS.UPLOAD_PROGRESS, {
      attachmentId: progress.attachmentId,
      sessionId: '',
      progress: percent,
      status: progress.phase
    })
  }
}

const getOrCreateAttachmentService = (): AttachmentSyncService | null => {
  if (attachmentService) return attachmentService

  attachmentService = new AttachmentSyncService({
    getAccessToken: () => getValidAccessToken(),
    getVaultKey: () => getOrDeriveVaultKey().catch(() => null),
    getSigningKeys: async () => {
      const secretKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY)
      if (!secretKey) return null
      const publicKey = getDevicePublicKey(secretKey)
      if (!isDatabaseInitialized()) {
        secureCleanup(secretKey)
        return null
      }
      const db = getDatabase()
      const device = db
        .select({ id: syncDevices.id })
        .from(syncDevices)
        .where(eq(syncDevices.isCurrentDevice, true))
        .get()
      if (!device) {
        secureCleanup(secretKey)
        return null
      }
      return { secretKey, publicKey, deviceId: device.id }
    },
    getDevicePublicKey: async (deviceId: string) => {
      if (!isDatabaseInitialized()) return null
      const db = getDatabase()
      const device = db
        .select({ signingPublicKey: syncDevices.signingPublicKey })
        .from(syncDevices)
        .where(eq(syncDevices.id, deviceId))
        .get()
      if (!device?.signingPublicKey) return null
      return sodium.from_base64(device.signingPublicKey, sodium.base64_variants.ORIGINAL)
    },
    getSyncServerUrl: () => SYNC_SERVER_URL
  })

  return attachmentService
}

// ============================================================================
// Exported cleanup helper for session-teardown module
// ============================================================================

export function clearInMemoryAuthState(): void {
  pendingRecoveryPhrase = null
  oauthSessions.clear()
  stopOtpClipboardDetection()
  shutdownLoopbackServer()
  if (uploadQueue) {
    uploadQueue.dispose()
    uploadQueue = null
  }
  attachmentService = null
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerSyncHandlers(syncEngine?: SyncEngine): void {
  const resolveSyncEngine = (): SyncEngine | null => syncEngine ?? getSyncEngine()

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
    })
  )

  ipcMain.handle(SYNC_CHANNELS.SETUP_NEW_ACCOUNT, async () => {
    const setupToken = await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN)
    if (!setupToken) {
      return { success: false, error: 'Session expired. Please sign in again.' }
    }

    const { deviceId } = await performFirstDeviceSetup(setupToken)
    return { success: true, deviceId }
  })

  ipcMain.handle(
    SYNC_CHANNELS.AUTH_RESEND_OTP,
    createValidatedHandler(ResendOtpSchema, async (input) => {
      startOtpClipboardDetection()
      return postToServer('/auth/otp/resend', { email: input.email })
    })
  )

  // --- OAuth Initiation with Loopback Redirect (T072, T072a) ---

  ipcMain.handle(
    SYNC_CHANNELS.AUTH_INIT_OAUTH,
    createValidatedHandler(InitOAuthSchema, async () => {
      cleanExpiredOAuthSessions()
      shutdownLoopbackServer()

      const { server, port } = await startLoopbackServer()
      activeLoopbackServer = server

      const redirectUri = `http://127.0.0.1:${port}/callback`

      const oauthUrl = `${SYNC_SERVER_URL}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
      const googleUrl = await new Promise<string>((resolve, reject) => {
        const mod = oauthUrl.startsWith('https') ? https : http
        mod
          .get(oauthUrl, (res) => {
            res.resume()
            const location = res.headers.location
            if (!location) {
              shutdownLoopbackServer()
              return reject(new Error('Failed to get OAuth URL from server'))
            }
            resolve(location)
          })
          .on('error', (err) => {
            shutdownLoopbackServer()
            reject(err)
          })
      })

      const parsedUrl = new URL(googleUrl)
      const state = parsedUrl.searchParams.get('state')
      if (!state) {
        shutdownLoopbackServer()
        throw new Error('Missing state in OAuth URL')
      }

      oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })

      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404)
          res.end()
          return
        }

        const oauthError = reqUrl.searchParams.get('error')
        if (oauthError) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML)

          const cbState = reqUrl.searchParams.get('state')
          if (cbState) oauthSessions.delete(cbState)

          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(SYNC_EVENTS.OAUTH_ERROR, { error: oauthError })
          }

          shutdownLoopbackServer()
          return
        }

        const code = reqUrl.searchParams.get('code')
        const cbState = reqUrl.searchParams.get('state')

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(SUCCESS_HTML)

        if (code && cbState) {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(SYNC_EVENTS.OAUTH_CALLBACK, { code, state: cbState })
          }
        }

        shutdownLoopbackServer()
      })

      setTimeout(shutdownLoopbackServer, OAUTH_SESSION_TIMEOUT_MS)

      await shell.openExternal(parsedUrl.toString())

      return { state }
    })
  )

  // --- Token Refresh (T073, T073a, T073c) ---

  ipcMain.handle(SYNC_CHANNELS.AUTH_REFRESH_TOKEN, async () => {
    const success = await refreshAccessToken()
    return { success, error: success ? undefined : 'Token refresh failed' }
  })

  // --- First Device Setup via OAuth (T057) ---

  ipcMain.handle(
    SYNC_CHANNELS.SETUP_FIRST_DEVICE,
    createValidatedHandler(SetupFirstDeviceSchema, async (input) => {
      const session = consumeOAuthSession(input.state)

      const raw = await postToServer<unknown>(`/auth/oauth/${input.provider}/callback`, {
        code: input.oauthToken,
        state: input.state,
        redirectUri: session.redirectUri
      })
      const serverResponse = OAuthCallbackResponseSchema.parse(raw)

      if (!serverResponse.setupToken) {
        throw new Error('OAuth callback missing setupToken')
      }

      await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, serverResponse.setupToken)

      if (serverResponse.needsSetup) {
        const { deviceId } = await performFirstDeviceSetup(serverResponse.setupToken)

        return {
          success: true,
          needsRecoverySetup: true,
          deviceId
        }
      }

      return { success: true, needsRecoverySetup: true, needsRecoveryInput: true }
    })
  )

  // --- Recovery Phrase Confirmation (T062) ---

  ipcMain.handle(
    SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
    createValidatedHandler(ConfirmRecoveryPhraseSchema, async (input) => {
      if (input.confirmed) {
        store.set('sync', { ...store.get('sync'), recoveryPhraseConfirmed: true })
        const engine = getSyncEngine()
        if (engine) {
          void engine.activate()
        } else {
          void startSyncRuntime()
        }
      }
      return { success: true }
    })
  )

  ipcMain.handle(SYNC_CHANNELS.GET_RECOVERY_PHRASE, () => {
    const phrase = pendingRecoveryPhrase
    pendingRecoveryPhrase = null
    return phrase
  })

  // --- Logout (clears all local auth state) ---

  ipcMain.handle(SYNC_CHANNELS.AUTH_LOGOUT, async () => {
    const result = await teardownSession('logout')
    return {
      success: true,
      ...(result.keychainFailures.length > 0 && {
        keychainWarning: `Failed to remove: ${result.keychainFailures.join(', ')}`
      })
    }
  })

  // --- Not-yet-implemented handlers ---

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, async () => {
    const accessToken = await getValidAccessToken()
    if (!accessToken) throw new Error('Not authenticated')
    return initiateDeviceLinking(accessToken)
  })

  ipcMain.handle(
    SYNC_CHANNELS.LINK_VIA_QR,
    createValidatedHandler(LinkViaQrSchema, async (input) => {
      const token = input.oauthToken || (await retrieveToken(KEYCHAIN_ENTRIES.SETUP_TOKEN))
      if (!token) throw new Error('No auth token available for device linking')
      return linkViaQr(input.qrData, token)
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.COMPLETE_LINKING_QR,
    createValidatedHandler(CompleteLinkingQrSchema, async (input) => {
      return completeLinkingQr(input.sessionId)
    })
  )
  ipcMain.handle(
    SYNC_CHANNELS.LINK_VIA_RECOVERY,
    createValidatedHandler(LinkViaRecoverySchema, async (input) => {
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
    })
  )
  ipcMain.handle(
    SYNC_CHANNELS.APPROVE_LINKING,
    createValidatedHandler(ApproveLinkingSchema, async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error('Not authenticated')
      return approveDeviceLinking(input.sessionId, accessToken)
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_LINKING_SAS,
    createValidatedHandler(GetLinkingSasSchema, async (input) => {
      const accessToken = await getValidAccessToken()
      if (!accessToken) throw new Error('Not authenticated')
      return getLinkingVerificationCode(input.sessionId, accessToken)
    })
  )

  ipcMain.handle(SYNC_CHANNELS.GET_DEVICES, async () => {
    if (!isDatabaseInitialized()) return { devices: [], email: undefined }
    const db = getDatabase()
    const rows = await db.select().from(syncDevices)
    const devices = rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform as 'macos' | 'windows' | 'linux' | 'ios' | 'android',
      linkedAt: d.linkedAt.getTime(),
      lastSyncAt: d.lastSyncAt?.getTime(),
      isCurrentDevice: d.isCurrentDevice
    }))
    const syncData = store.get('sync')
    return { devices, email: syncData.email }
  })
  ipcMain.handle(
    SYNC_CHANNELS.REMOVE_DEVICE,
    createValidatedHandler(RemoveDeviceSchema, async (input) => {
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

      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.DEVICE_REMOVED, { deviceId: input.deviceId })
      }

      logger.info(`Device removed: ${input.deviceId}`)
      return { success: true }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.RENAME_DEVICE,
    createValidatedHandler(RenameDeviceSchema, async (input) => {
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

      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.DEVICE_RENAMED, {
          deviceId: input.deviceId,
          name: input.newName
        })
      }

      logger.info(`Device renamed: ${input.deviceId} → ${input.newName}`)
      return { success: true }
    })
  )

  ipcMain.handle(SYNC_CHANNELS.GET_STATUS, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { status: 'idle', pendingCount: 0 }
    return engine.getStatus()
  })

  ipcMain.handle(SYNC_CHANNELS.TRIGGER_SYNC, async () => {
    const engine = resolveSyncEngine()
    if (!engine) {
      return { success: false, error: 'Sync engine not initialized. Open a vault to start sync.' }
    }
    return withErrorHandler(async () => {
      await engine.fullSync()
      return { success: true }
    }, 'Sync failed')()
  })

  ipcMain.handle(
    SYNC_CHANNELS.GET_HISTORY,
    createValidatedHandler(GetHistorySchema, (input) => {
      if (!isDatabaseInitialized()) {
        return { entries: [], total: 0 }
      }
      const db = getDatabase()
      const limit = input.limit ?? 50
      const offset = input.offset ?? 0

      const rows = db
        .select()
        .from(syncHistory)
        .orderBy(desc(syncHistory.createdAt))
        .limit(limit)
        .offset(offset)
        .all()

      const [totalRow] = db.select({ total: count() }).from(syncHistory).all()

      return {
        entries: rows.map((r) => ({
          id: r.id,
          type: r.type as 'push' | 'pull' | 'error',
          itemCount: r.itemCount,
          direction: r.direction ?? undefined,
          details: r.details ? parseSyncHistoryDetails(r.details) : undefined,
          durationMs: r.durationMs ?? undefined,
          createdAt: r.createdAt.getTime()
        })),
        total: totalRow?.total ?? 0
      }
    })
  )

  ipcMain.handle(SYNC_CHANNELS.GET_QUEUE_SIZE, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { pending: 0, failed: 0 }
    const stats = engine.getQueueStats()
    return { pending: stats.pending, failed: stats.failed }
  })

  ipcMain.handle(SYNC_CHANNELS.PAUSE, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { success: false, wasPaused: false }
    return engine.pause()
  })

  ipcMain.handle(SYNC_CHANNELS.RESUME, () => {
    const engine = resolveSyncEngine()
    if (!engine) return { success: false, pendingCount: 0 }
    return engine.resume()
  })

  ipcMain.handle(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, (_event, input: unknown) => {
    const parsed = UpdateSyncedSettingSchema.parse(input)
    const manager = getSettingsSyncManager()
    if (!manager) return { success: false, error: 'Settings sync not initialized' }

    manager.updateField(parsed.fieldPath, parsed.value, 'local')
    return { success: true }
  })

  ipcMain.handle(SYNC_CHANNELS.GET_SYNCED_SETTINGS, () => {
    const manager = getSettingsSyncManager()
    if (!manager) return null
    return manager.getSettings()
  })

  ipcMain.handle(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN, async () => {
    const token = await getValidAccessToken()
    if (!token) return null
    return getFromServer<StorageBreakdownResult>('/sync/storage', token)
  })

  // --- Attachment Sync Handlers (T159–T162) ---

  ipcMain.handle(
    SYNC_CHANNELS.UPLOAD_ATTACHMENT,
    createValidatedHandler(UploadAttachmentSchema, async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: 'Not authenticated' }

      const queue = getOrCreateUploadQueue()
      if (!queue) return { success: false, error: 'Sync not initialized' }

      try {
        const result = await queue.enqueue(input.noteId, input.filePath, broadcastUploadProgress)
        return { success: true, attachmentId: result.attachmentId, sessionId: result.sessionId }
      } catch (err) {
        logger.error('Attachment upload failed', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
    createValidatedHandler(GetUploadProgressSchema, (input) => {
      const service = getOrCreateAttachmentService()
      if (!service) return null
      const progress = service.getUploadProgress(input.sessionId)
      if (!progress) return null
      return {
        progress:
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0,
        uploadedChunks: progress.chunksCompleted,
        totalChunks: progress.totalChunks,
        status: 'uploading' as const
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
    createValidatedHandler(DownloadAttachmentSchema, async (input) => {
      const token = await getValidAccessToken()
      if (!token) return { success: false, error: 'Not authenticated' }

      const service = getOrCreateAttachmentService()
      if (!service) return { success: false, error: 'Sync not initialized' }

      service.setProgressCallback((progress) => {
        const percent =
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SYNC_EVENTS.DOWNLOAD_PROGRESS, {
            attachmentId: progress.attachmentId,
            progress: percent,
            status: progress.phase
          })
        }
      })

      try {
        const targetPath = input.targetPath ?? ''
        if (!targetPath) return { success: false, error: 'Target path is required' }

        const vaultStatus = getVaultStatus()
        if (vaultStatus.path) {
          const resolved = path.resolve(targetPath)
          const vaultAttachments = path.resolve(vaultStatus.path, 'attachments')
          if (!resolved.startsWith(vaultAttachments + path.sep) && resolved !== vaultAttachments) {
            return {
              success: false,
              error: 'Target path must be within the vault attachments directory'
            }
          }
        }

        const result = await service.downloadAttachment(input.attachmentId, targetPath)
        return { success: true, filePath: result.filePath }
      } catch (err) {
        logger.error('Attachment download failed', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        service.setProgressCallback(null)
      }
    })
  )

  ipcMain.handle(
    SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
    createValidatedHandler(GetDownloadProgressSchema, (input) => {
      const service = getOrCreateAttachmentService()
      if (!service) return null
      const progress = service.getDownloadProgress(input.attachmentId)
      if (!progress) return null
      return {
        progress:
          progress.totalChunks > 0
            ? Math.round((progress.chunksCompleted / progress.totalChunks) * 100)
            : 0,
        downloadedChunks: progress.chunksCompleted,
        totalChunks: progress.totalChunks,
        status: 'downloading' as const
      }
    })
  )

  attachmentEvents.onSaved(async ({ noteId, diskPath }) => {
    const token = await getValidAccessToken()
    if (!token) return

    const queue = getOrCreateUploadQueue()
    if (!queue) return
    try {
      const result = await queue.enqueue(noteId, diskPath, broadcastUploadProgress)
      if (isDatabaseInitialized()) {
        updateNoteCache(getIndexDatabase(), noteId, { attachmentId: result.attachmentId })
        updateNoteMetadata(getDatabase(), noteId, {
          attachmentId: result.attachmentId,
          attachmentReferences: [result.attachmentId]
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Attachment upload failed', { noteId, diskPath, error: message })
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
          noteId,
          diskPath,
          error: message
        })
      }
    }
  })

  attachmentEvents.onDownloadNeeded(async ({ noteId, attachmentId, diskPath }) => {
    const token = await getValidAccessToken()
    if (!token) return

    const service = getOrCreateAttachmentService()
    if (!service) return
    try {
      markWritebackIgnored(diskPath)
      await service.downloadAttachment(attachmentId, diskPath)
      const stats = await fs.promises.stat(diskPath)
      if (isDatabaseInitialized()) {
        updateNoteCache(getIndexDatabase(), noteId, { fileSize: stats.size })
        updateNoteMetadata(getDatabase(), noteId, { fileSize: stats.size })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Attachment download failed', { noteId, attachmentId, diskPath, error: message })
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(SYNC_EVENTS.ATTACHMENT_UPLOAD_FAILED, {
          noteId,
          diskPath,
          error: message
        })
      }
    }
  })

  ipcMain.handle(SYNC_CHANNELS.GET_QUARANTINED_ITEMS, () => {
    const engine = resolveSyncEngine()
    if (!engine) return []
    return engine.getQuarantinedItems()
  })

  ipcMain.handle(SYNC_CHANNELS.CHECK_DEVICE_STATUS, async () => {
    const engine = resolveSyncEngine()
    if (!engine) return { status: 'unknown' }
    const status = await engine.checkDeviceStatus()
    return { status }
  })

  ipcMain.handle(SYNC_CHANNELS.EMERGENCY_WIPE, async () => {
    const engine = resolveSyncEngine()
    if (engine) {
      await engine.performEmergencyWipe()
    }
    const result = await teardownSession('integrity')
    logger.warn('SECURITY_AUDIT: Emergency wipe via IPC complete')
    return { success: result.success }
  })

  logger.info('Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  attachmentEvents.removeAllListeners('saved')
  attachmentEvents.removeAllListeners('download-needed')
  stopOtpClipboardDetection()
  cancelTokenRefresh()
  pendingRecoveryPhrase = null
  oauthSessions.clear()
  shutdownLoopbackServer()
  uploadQueue?.dispose()
  uploadQueue = null
  attachmentService = null

  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REFRESH_TOKEN)

  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_NEW_ACCOUNT)
  ipcMain.removeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_RECOVERY_PHRASE)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_LOGOUT)

  ipcMain.removeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.COMPLETE_LINKING_QR)
  ipcMain.removeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY)
  ipcMain.removeHandler(SYNC_CHANNELS.APPROVE_LINKING)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_LINKING_SAS)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_DEVICES)
  ipcMain.removeHandler(SYNC_CHANNELS.REMOVE_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.RENAME_DEVICE)

  ipcMain.removeHandler(SYNC_CHANNELS.GET_STATUS)
  ipcMain.removeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_HISTORY)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)
  ipcMain.removeHandler(SYNC_CHANNELS.PAUSE)
  ipcMain.removeHandler(SYNC_CHANNELS.RESUME)

  ipcMain.removeHandler(SYNC_CHANNELS.UPDATE_SYNCED_SETTING)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_SYNCED_SETTINGS)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)

  logger.info('Sync handlers unregistered')
}

export function seedOAuthSession(state: string, redirectUri: string): void {
  oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })
}
