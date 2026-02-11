import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import http from 'node:http'
import https from 'node:https'
import os from 'os'
import sodium from 'libsodium-wrappers-sumo'

import { syncDevices } from '@shared/db/schema/sync-devices'
import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@shared/contracts/crypto'
import {
  RequestOtpSchema,
  VerifyOtpSchema,
  ResendOtpSchema,
  InitOAuthSchema,
  SetupFirstDeviceSchema,
  ConfirmRecoveryPhraseSchema
} from '@shared/contracts/ipc-auth'
import { RefreshTokenResponseSchema } from '@shared/contracts/auth-api'
import { LinkViaRecoverySchema } from '@shared/contracts/ipc-devices'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@shared/contracts/ipc-sync'

import { eq } from 'drizzle-orm'

import {
  constantTimeEqual,
  deleteKey,
  deriveKey,
  deriveMasterKey,
  generateDeviceSigningKeyPair,
  generateRecoveryPhrase,
  generateSalt,
  getDevicePublicKey,
  phraseToSeed,
  secureCleanup,
  storeKey,
  retrieveKey,
  validateRecoveryPhrase
} from '../crypto'
import { getDatabase } from '../database/client'
import { store } from '../store'
import { getFromServer, postToServer, SyncServerError } from '../sync/http-client'

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

interface RecoveryInfoResponse {
  kdfSalt: string
  keyVerifier: string
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
// Token Refresh (T073, T073a)
// ============================================================================

const ACCESS_TOKEN_EXPIRY_SECONDS = 900
const REFRESH_MAX_RETRIES = 3
const REFRESH_BACKOFF_BASE_MS = 1000

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let activeRefreshPromise: Promise<boolean> | null = null

const scheduleTokenRefresh = (expiresInSeconds: number): void => {
  cancelTokenRefresh()
  const jitter = 0.75 + Math.random() * 0.1
  const refreshAtMs = Math.floor(expiresInSeconds * jitter) * 1000
  refreshTimer = setTimeout(() => {
    void refreshAccessToken()
  }, refreshAtMs)
}

const cancelTokenRefresh = (): void => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

const emitSessionExpired = (): void => {
  cancelTokenRefresh()
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(SYNC_EVENTS.SESSION_EXPIRED, {
      reason: 'token_expired'
    })
  }
}

const doRefreshAccessToken = async (): Promise<boolean> => {
  const currentRefreshToken = await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  if (!currentRefreshToken) {
    emitSessionExpired()
    return false
  }

  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
    try {
      const raw = await postToServer<unknown>('/auth/refresh', {
        refreshToken: currentRefreshToken
      })
      const response = RefreshTokenResponseSchema.parse(raw)

      await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, response.accessToken)
      await storeToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN, response.refreshToken)
      scheduleTokenRefresh(response.expiresIn)
      return true
    } catch (error: unknown) {
      if (error instanceof SyncServerError && error.statusCode === 401) break

      if (attempt < REFRESH_MAX_RETRIES - 1) {
        const backoff = REFRESH_BACKOFF_BASE_MS * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    }
  }

  emitSessionExpired()
  return false
}

const refreshAccessToken = async (): Promise<boolean> => {
  if (activeRefreshPromise) return activeRefreshPromise

  activeRefreshPromise = doRefreshAccessToken()
  try {
    return await activeRefreshPromise
  } finally {
    activeRefreshPromise = null
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
    scheduleTokenRefresh(ACCESS_TOKEN_EXPIRY_SECONDS)

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

      store.set('sync', { ...store.get('sync'), email: input.email })

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
        isNewUser: serverResponse.isNewUser,
        needsRecoverySetup: true,
        needsRecoveryInput: true
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

        const code = reqUrl.searchParams.get('code')
        const cbState = reqUrl.searchParams.get('state')

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(SUCCESS_HTML)

        if (code && cbState) {
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
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

      const serverResponse = await postToServer<OAuthCallbackServerResponse>(
        `/auth/oauth/${input.provider}/callback`,
        { code: input.oauthToken, state: input.state, redirectUri: session.redirectUri }
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

      return { success: true, needsRecoverySetup: true, needsRecoveryInput: true }
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

  // --- Logout (clears all local auth state) ---

  ipcMain.handle(SYNC_CHANNELS.AUTH_LOGOUT, async () => {
    cancelTokenRefresh()

    const keychainEntries = [
      KEYCHAIN_ENTRIES.ACCESS_TOKEN,
      KEYCHAIN_ENTRIES.REFRESH_TOKEN,
      KEYCHAIN_ENTRIES.SETUP_TOKEN,
      KEYCHAIN_ENTRIES.MASTER_KEY,
      KEYCHAIN_ENTRIES.VAULT_KEY,
      KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY
    ]
    await Promise.allSettled(keychainEntries.map((entry) => deleteKey(entry)))

    const db = getDatabase()
    await db.delete(syncDevices).where(eq(syncDevices.isCurrentDevice, true))

    store.set('sync', {})

    return { success: true }
  })

  // --- Not-yet-implemented handlers ---

  ipcMain.handle(SYNC_CHANNELS.GENERATE_LINKING_QR, notImplemented('GENERATE_LINKING_QR'))
  ipcMain.handle(SYNC_CHANNELS.LINK_VIA_QR, notImplemented('LINK_VIA_QR'))
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

      const recoveryInfo = await getFromServer<RecoveryInfoResponse>(
        '/auth/recovery-info',
        setupToken
      )

      const seed = await phraseToSeed(input.recoveryPhrase)
      const saltBytes = sodium.from_base64(recoveryInfo.kdfSalt, sodium.base64_variants.ORIGINAL)

      let masterKey: Uint8Array | undefined
      let vaultKey: Uint8Array | undefined
      let signingSecretKey: Uint8Array | undefined

      try {
        const derived = await deriveMasterKey(seed, saltBytes)
        masterKey = derived.masterKey

        const serverVerifierBytes = new TextEncoder().encode(recoveryInfo.keyVerifier)
        const derivedVerifierBytes = new TextEncoder().encode(derived.keyVerifier)

        if (!constantTimeEqual(derivedVerifierBytes, serverVerifierBytes)) {
          return { success: false, error: 'Recovery phrase does not match. Please try again.' }
        }

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

        return { success: true, deviceId: deviceResponse.deviceId }
      } finally {
        secureCleanup(seed, saltBytes)
        if (masterKey) secureCleanup(masterKey)
        if (vaultKey) secureCleanup(vaultKey)
        if (signingSecretKey) secureCleanup(signingSecretKey)
      }
    })
  )
  ipcMain.handle(SYNC_CHANNELS.APPROVE_LINKING, notImplemented('APPROVE_LINKING'))

  ipcMain.handle(SYNC_CHANNELS.GET_DEVICES, async () => {
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
  cancelTokenRefresh()
  oauthSessions.clear()
  shutdownLoopbackServer()

  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REFRESH_TOKEN)

  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_LOGOUT)

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

export function seedOAuthSession(state: string, redirectUri: string): void {
  oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })
}
