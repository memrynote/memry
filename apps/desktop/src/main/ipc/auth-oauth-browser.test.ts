import http from 'node:http'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  send: vi.fn(),
  postToServer: vi.fn(),
  storeToken: vi.fn(),
  log: vi.fn(),
  trackMainError: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))
vi.mock('../store', () => ({ store: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../database', () => ({ getDatabase: vi.fn() }))
vi.mock('../database/client', () => ({ isDatabaseInitialized: vi.fn(() => false) }))
vi.mock('../sync/http-client', () => ({ postToServer: mocks.postToServer }))
vi.mock('../sync/runtime', () => ({ getSyncEngine: vi.fn(), startSyncRuntime: vi.fn() }))
vi.mock('../calendar/google/google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: vi.fn()
}))
vi.mock('../sync/device-registration', () => ({
  signInKnownDevice: vi.fn(async () => 'known-device')
}))
vi.mock('../sync/session-teardown', () => ({ teardownSession: vi.fn() }))
vi.mock('../sync/token-manager', () => ({
  hasSessionEnded: vi.fn(),
  refreshAccessToken: vi.fn(),
  storeToken: mocks.storeToken
}))
vi.mock('../sync/setup-token', () => ({
  getSetupDevicePublicKey: vi.fn(async () => 'test-device-public-key')
}))
vi.mock('./auth-device-handlers', () => ({
  clearPendingRecoveryPhrase: vi.fn(),
  getPendingRecoveryPhrase: vi.fn(),
  performFirstDeviceSetup: vi.fn()
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: mocks.log,
    info: mocks.log,
    warn: mocks.log,
    error: mocks.log
  })
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: mocks.trackMainError }))

import { registerAuthOAuthHandlers, unregisterAuthOAuthHandlers } from './auth-oauth-handlers'

const state = 'browser-handoff-state'
const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`
const retryChannel = 'auth:retry-oauth'

interface OAuthLaunchResult {
  state: string
  authorizationUrl: string
  browserOpened: boolean
}

function requestLoopback(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

describe('OAuth browser handoff through IPC and a real loopback server', () => {
  let syncServer: http.Server
  let redirectUri = ''
  let initiationRequests = 0

  beforeEach(async () => {
    vi.clearAllMocks()
    resetIpcMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    initiationRequests = 0
    redirectUri = ''
    mocks.openExternal.mockResolvedValue(undefined)
    mocks.storeToken.mockResolvedValue(undefined)
    mocks.postToServer.mockResolvedValue({
      success: true,
      isNewUser: false,
      needsSetup: false,
      knownDevice: true,
      setupToken: 'test-setup-token'
    })
    syncServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/auth/oauth/google') {
        res.writeHead(404).end()
        return
      }
      initiationRequests += 1
      redirectUri = url.searchParams.get('redirect_uri') ?? ''
      res.writeHead(302, { Location: authorizationUrl }).end()
    })
    await new Promise<void>((resolve) => syncServer.listen(0, '127.0.0.1', resolve))
    const address = syncServer.address()
    if (!address || typeof address === 'string') throw new Error('Test sync server did not bind')
    vi.stubEnv('SYNC_SERVER_URL', `http://127.0.0.1:${address.port}`)
    registerAuthOAuthHandlers()
  })

  afterEach(async () => {
    unregisterAuthOAuthHandlers()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await new Promise<void>((resolve, reject) => {
      syncServer.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('returns the sign-in link after browser failure and accepts its manual callback exactly once', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error(`gio open failed for ${authorizationUrl}`))

    const result = await invokeHandler<OAuthLaunchResult>(SYNC_CHANNELS.AUTH_INIT_OAUTH, {
      provider: 'google'
    })

    expect(result).toEqual({ state, authorizationUrl, browserOpened: false })
    expect(new URL(redirectUri)).toMatchObject({
      protocol: 'http:',
      hostname: '127.0.0.1',
      pathname: '/callback'
    })
    expect(await requestLoopback(`${redirectUri}?code=wrong-code&state=wrong-state`)).toBe(400)
    expect(await requestLoopback(`${redirectUri}?error=access_denied&state=wrong-state`)).toBe(400)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(await requestLoopback(`${redirectUri}?code=manual-code&state=${state}`)).toBe(200)
    expect(mocks.send).toHaveBeenCalledWith(SYNC_EVENTS.OAUTH_CALLBACK, {
      code: 'manual-code',
      state
    })

    const input = { provider: 'google', oauthToken: 'manual-code', state }
    await expect(invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, input)).resolves.toEqual({
      success: true,
      needsRecoverySetup: false,
      needsRecoveryInput: false,
      deviceId: 'known-device'
    })
    expect(mocks.postToServer).toHaveBeenCalledWith('/auth/oauth/google/callback', {
      code: 'manual-code',
      state,
      redirectUri,
      devicePublicKey: 'test-device-public-key'
    })
    await expect(invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, input)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired OAuth state parameter'
    })
    expect(mocks.postToServer).toHaveBeenCalledTimes(1)
    expect(inspect(mocks.log.mock.calls)).not.toContain(authorizationUrl)
    expect(inspect(mocks.log.mock.calls)).not.toContain('manual-code')
    expect(inspect(mocks.trackMainError.mock.calls)).not.toContain(authorizationUrl)
    expect(inspect(mocks.trackMainError.mock.calls)).not.toContain('manual-code')
  })

  it('retries the existing browser handoff without replacing its state or loopback listener', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('No browser available'))
    const result = await invokeHandler<OAuthLaunchResult>(SYNC_CHANNELS.AUTH_INIT_OAUTH, {
      provider: 'google'
    })
    expect(result).toEqual({ state, authorizationUrl, browserOpened: false })
    const originalRedirect = redirectUri

    await expect(invokeHandler(retryChannel, { state: result.state })).resolves.toEqual({
      browserOpened: true
    })

    expect(initiationRequests).toBe(1)
    expect(mocks.openExternal.mock.calls).toEqual([[authorizationUrl], [authorizationUrl]])
    expect(await requestLoopback(`${originalRedirect}?code=retry-code&state=${state}`)).toBe(200)
    expect(mocks.send).toHaveBeenCalledWith(SYNC_EVENTS.OAUTH_CALLBACK, {
      code: 'retry-code',
      state
    })
  })

  it('does not launch a browser for an unknown or expired retry state', async () => {
    await invokeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH, { provider: 'google' })
    mocks.openExternal.mockClear()

    await expect(invokeHandler(retryChannel, { state: 'unknown-state' })).resolves.toMatchObject({
      success: false
    })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
    await expect(invokeHandler(retryChannel, { state })).resolves.toMatchObject({ success: false })

    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
