import { BrowserWindow, ipcMain, shell } from 'electron'
import http from 'node:http'
import https from 'node:https'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import {
  InitOAuthSchema,
  SetupFirstDeviceSchema,
  ConfirmRecoveryPhraseSchema
} from '@memry/contracts/ipc-auth'
import { OAuthCallbackResponseSchema } from '@memry/contracts/auth-api'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'

import { store } from '../store'
import { postToServer } from '../sync/http-client'
import { resolveSyncServerUrl } from '../sync/sync-server-url'
import { getSyncEngine, startSyncRuntime } from '../sync/runtime'
import { startGoogleCalendarSyncRunner } from '../calendar/google/sync-service'
import { teardownSession } from '../sync/session-teardown'
import { refreshAccessToken, storeToken } from '../sync/token-manager'
import { createLogger } from '../lib/logger'
import { registerCommand } from './lib/register-command'
import {
  clearPendingRecoveryPhrase,
  getPendingRecoveryPhrase,
  performFirstDeviceSetup
} from './auth-device-handlers'

const logger = createLogger('IPC:Sync:OAuth')

// ============================================================================
// OAuth State & Loopback Server (T072, T072a)
// ============================================================================

interface OAuthSession {
  state: string
  redirectUri: string
  createdAt: number
}

const oauthSessions = new Map<string, OAuthSession>()
const OAUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000
// Cap how long we wait for the sync server to hand back the Google OAuth URL.
// Without it, a server that accepts the socket but never responds leaves the
// IPC call unsettled, so the "Continue with Google" button spins forever.
const OAUTH_INIT_REQUEST_TIMEOUT_MS = 15 * 1000
let activeLoopbackServer: http.Server | null = null

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
<html><head><meta charset="utf-8"><title>memrynote</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center}h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#999}</style></head>
<body><div class="c"><h1>Signed in</h1><p>You can close this tab and return to memrynote.</p></div></body></html>`

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>memrynote</title>
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
// Test seam — let tests inject an OAuth state without hitting Google
// ============================================================================

export function seedOAuthSession(state: string, redirectUri: string): void {
  oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })
}

// ============================================================================
// State cleanup (composed by sync-handlers' clearInMemoryAuthState)
// ============================================================================

export function clearOAuthState(): void {
  oauthSessions.clear()
  shutdownLoopbackServer()
}

// ============================================================================
// Handler Registration
// ============================================================================

export function registerAuthOAuthHandlers(): void {
  // --- OAuth Initiation with Loopback Redirect (T072, T072a) ---

  registerCommand(
    SYNC_CHANNELS.AUTH_INIT_OAUTH,
    InitOAuthSchema,
    async () => {
      cleanExpiredOAuthSessions()
      shutdownLoopbackServer()

      const { server, port } = await startLoopbackServer()
      activeLoopbackServer = server

      const redirectUri = `http://127.0.0.1:${port}/callback`

      const oauthUrl = `${resolveSyncServerUrl()}/auth/oauth/google?redirect_uri=${encodeURIComponent(redirectUri)}`
      const googleUrl = await new Promise<string>((resolve, reject) => {
        const mod = oauthUrl.startsWith('https') ? https : http
        const req = mod.get(oauthUrl, (res) => {
          res.resume()
          const location = res.headers.location
          if (!location) {
            shutdownLoopbackServer()
            return reject(new Error('Failed to get OAuth URL from server'))
          }
          resolve(location)
        })
        req.on('error', (err) => {
          shutdownLoopbackServer()
          reject(err)
        })
        req.setTimeout(OAUTH_INIT_REQUEST_TIMEOUT_MS, () => {
          shutdownLoopbackServer()
          req.destroy(new Error('Timed out contacting sync server for OAuth URL'))
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
    },
    'errors:auth.initiateOAuthFailed'
  )

  // --- Token Refresh (T073, T073a, T073c) ---

  ipcMain.handle(SYNC_CHANNELS.AUTH_REFRESH_TOKEN, async () => {
    const success = await refreshAccessToken()
    return { success, error: success ? undefined : 'Token refresh failed' }
  })

  // --- First Device Setup via OAuth (T057) ---

  registerCommand(
    SYNC_CHANNELS.SETUP_FIRST_DEVICE,
    SetupFirstDeviceSchema,
    async (input) => {
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
    },
    'errors:auth.setupFirstDeviceOAuthFailed'
  )

  // --- Recovery Phrase Confirmation (T062) ---

  registerCommand(
    SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
    ConfirmRecoveryPhraseSchema,
    async (input) => {
      if (input.confirmed) {
        store.set('sync', { ...store.get('sync'), recoveryPhraseConfirmed: true })
        clearPendingRecoveryPhrase()
        const engine = getSyncEngine()
        if (engine) {
          void engine.activate()
        } else {
          void startSyncRuntime()
        }
        void startGoogleCalendarSyncRunner().catch(() => {
          // Runner self-logs on failure.
        })
      }
      return { success: true }
    },
    'errors:auth.confirmRecoveryPhraseFailed'
  )

  ipcMain.handle(SYNC_CHANNELS.GET_RECOVERY_PHRASE, () => {
    return getPendingRecoveryPhrase()
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

  logger.debug('Auth/OAuth handlers registered')
}

export function unregisterAuthOAuthHandlers(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_REFRESH_TOKEN)
  ipcMain.removeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE)
  ipcMain.removeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE)
  ipcMain.removeHandler(SYNC_CHANNELS.GET_RECOVERY_PHRASE)
  ipcMain.removeHandler(SYNC_CHANNELS.AUTH_LOGOUT)
  oauthSessions.clear()
  shutdownLoopbackServer()
}
