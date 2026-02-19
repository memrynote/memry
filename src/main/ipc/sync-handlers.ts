import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import http from 'node:http'
import https from 'node:https'
import os from 'os'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@shared/db/schema/sync-devices'
import { syncState } from '@shared/db/schema/sync-state'
import { KEYCHAIN_ENTRIES } from '@shared/contracts/crypto'
import {
  RequestOtpSchema,
  VerifyOtpSchema,
  ResendOtpSchema,
  InitOAuthSchema,
  SetupFirstDeviceSchema,
  ConfirmRecoveryPhraseSchema
} from '@shared/contracts/ipc-auth'
import {
  DeviceRegisterResponseSchema,
  OAuthCallbackResponseSchema,
  RecoveryDataResponseSchema,
  VerifyOtpResponseSchema
} from '@shared/contracts/auth-api'
import type { DeviceRegisterResponse } from '@shared/contracts/auth-api'
import {
  ApproveLinkingSchema,
  CompleteLinkingQrSchema,
  LinkViaQrSchema,
  LinkViaRecoverySchema
} from '@shared/contracts/ipc-devices'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@shared/contracts/ipc-sync'
import { GetHistorySchema, UpdateSyncedSettingSchema } from '@shared/contracts/ipc-sync-ops'
import {
  approveDeviceLinking,
  completeLinkingQr,
  initiateDeviceLinking,
  linkViaQr
} from '../sync/linking-service'
import { getSettingsSyncManager } from '../sync/settings-sync'
import { syncHistory } from '@shared/db/schema/sync-history'

import { eq, desc, count, inArray } from 'drizzle-orm'

import type { SyncEngine } from '../sync/engine'

import {
  deleteKey,
  deriveMasterKey,
  generateRecoveryPhrase,
  generateSalt,
  getDevicePublicKey,
  getOrCreateSigningKeyPair,
  recoverMasterKeyFromPhrase,
  secureCleanup,
  storeKey,
  retrieveKey,
  validateKeyVerifier,
  validateRecoveryPhrase
} from '../crypto'
import { getDatabase, isDatabaseInitialized } from '../database/client'
import { store } from '../store'
import { deleteFromServer, getFromServer, postToServer } from '../sync/http-client'

import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'
import { getSyncEngine } from '../sync/runtime'
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

  let deviceResponse: DeviceRegisterResponse
  try {
    deviceResponse = await registerDevice(setupToken, signingSecretKey)
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
// Stub helper for not-yet-implemented handlers
// ============================================================================

const notImplemented =
  (feature: string, phase: number) =>
  (): {
    success: false
    error: string
  } => {
    logger.warn(`Attempted to use unimplemented feature: ${feature} (Phase ${phase})`)
    return { success: false, error: `${feature} is not yet available` }
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
      await cleanupLocalSyncState(db)
      return
    }

    const signingKey = await retrieveKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY).catch(() => null)
    if (!signingKey) {
      logger.error(
        'Signing key missing from keychain but device registered. ' +
          'Cleaning up local state. User will need to re-authenticate.',
        { deviceId: currentDevice.id }
      )
      await cleanupLocalSyncState(db)
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

async function cleanupLocalSyncState(db: ReturnType<typeof getDatabase>): Promise<void> {
  await db.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true))
  await Promise.allSettled([
    deleteKey(KEYCHAIN_ENTRIES.ACCESS_TOKEN),
    deleteKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN),
    deleteKey(KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY),
    deleteKey(KEYCHAIN_ENTRIES.MASTER_KEY)
  ])
  store.set('sync', {})
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

      await storeToken(KEYCHAIN_ENTRIES.SETUP_TOKEN, serverResponse.setupToken)

      return {
        success: true,
        isNewUser: serverResponse.isNewUser,
        needsSetup: serverResponse.needsSetup,
        needsRecoveryInput: !serverResponse.needsSetup
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
    createValidatedHandler(ConfirmRecoveryPhraseSchema, (input) => {
      if (input.confirmed) {
        store.set('sync', { ...store.get('sync'), recoveryPhraseConfirmed: true })
        const engine = getSyncEngine()
        if (engine) void engine.activate()
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
    cancelTokenRefresh()
    pendingRecoveryPhrase = null

    const keychainEntries = [
      KEYCHAIN_ENTRIES.ACCESS_TOKEN,
      KEYCHAIN_ENTRIES.REFRESH_TOKEN,
      KEYCHAIN_ENTRIES.SETUP_TOKEN,
      KEYCHAIN_ENTRIES.MASTER_KEY,
      KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY
    ]
    await Promise.allSettled(keychainEntries.map((entry) => deleteKey(entry)))

    const db = getDatabase()
    await db.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true))

    store.set('sync', {})

    return { success: true }
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
  ipcMain.handle(SYNC_CHANNELS.REMOVE_DEVICE, notImplemented('device removal', 5))
  ipcMain.handle(SYNC_CHANNELS.RENAME_DEVICE, notImplemented('device rename', 5))

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
    try {
      await engine.fullSync()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
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

  ipcMain.handle(SYNC_CHANNELS.UPLOAD_ATTACHMENT, notImplemented('attachment upload', 6))
  ipcMain.handle(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, notImplemented('attachment upload progress', 6))
  ipcMain.handle(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, notImplemented('attachment download', 6))
  ipcMain.handle(
    SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
    notImplemented('attachment download progress', 6)
  )

  logger.info('Sync handlers registered')
}

export function unregisterSyncHandlers(): void {
  stopOtpClipboardDetection()
  cancelTokenRefresh()
  pendingRecoveryPhrase = null
  oauthSessions.clear()
  shutdownLoopbackServer()

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

  ipcMain.removeHandler(SYNC_CHANNELS.UPLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_UPLOAD_PROGRESS)
  ipcMain.removeHandler(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS)

  logger.info('Sync handlers unregistered')
}

export function seedOAuthSession(state: string, redirectUri: string): void {
  oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })
}
