import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

const mockPostToServer = vi.fn()
vi.mock('../sync/http-client', () => ({
  postToServer: (...args: unknown[]) => mockPostToServer(...args),
  getFromServer: vi.fn(),
  deleteFromServer: vi.fn(),
  patchToServer: vi.fn(),
  SyncServerError: class SyncServerError extends Error {
    status: number
    constructor(msg: string, status: number) {
      super(msg)
      this.status = status
    }
  }
}))

const mockSecureCleanup = vi.fn()
const mockDeriveMasterKey = vi.fn()
const mockGenerateRecoveryPhrase = vi.fn()
const mockGenerateSalt = vi.fn()
const mockGetOrCreateSigningKeyPair = vi.fn()

vi.mock('../crypto', () => ({
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args),
  deriveMasterKey: (...args: unknown[]) => mockDeriveMasterKey(...args),
  getOrCreateSigningKeyPair: () => mockGetOrCreateSigningKeyPair(),
  generateRecoveryPhrase: () => mockGenerateRecoveryPhrase(),
  generateSalt: () => mockGenerateSalt()
}))

const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('../store', () => ({
  store: {
    get: (...args: unknown[]) => mockStoreGet(...args),
    set: (...args: unknown[]) => mockStoreSet(...args)
  }
}))

const mockPersistKeysAndRegisterDevice = vi.fn()
vi.mock('../sync/device-registration', () => ({
  persistKeysAndRegisterDevice: (...args: unknown[]) => mockPersistKeysAndRegisterDevice(...args)
}))

const mockGetSyncEngine = vi.fn().mockReturnValue(null)
const mockStartSyncRuntime = vi.fn()
vi.mock('../sync/runtime', () => ({
  getSyncEngine: () => mockGetSyncEngine(),
  startSyncRuntime: (...args: unknown[]) => mockStartSyncRuntime(...args)
}))

const mockTeardownSession = vi.fn()
vi.mock('../sync/session-teardown', () => ({
  teardownSession: (...args: unknown[]) => mockTeardownSession(...args)
}))

const mockStoreToken = vi.fn()
const mockRefreshAccessToken = vi.fn()
vi.mock('../sync/token-manager', () => ({
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
  retrieveToken: vi.fn(),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args)
}))

const mockStartGoogleRunner = vi.fn()
vi.mock('../calendar/google/sync-service', () => ({
  startGoogleCalendarSyncRunner: (...args: unknown[]) => mockStartGoogleRunner(...args)
}))

const loopback = vi.hoisted(() => {
  const state = {
    requestHandler: undefined as undefined | ((req: any, res: any) => void),
    close: vi.fn(),
    listen: vi.fn(),
    address: vi.fn(() => ({ port: 4321 })),
    httpGet: vi.fn(),
    httpsGet: vi.fn(),
    shellOpenExternal: vi.fn()
  }
  return {
    ...state,
    get requestHandler() {
      return state.requestHandler
    },
    set requestHandler(handler: undefined | ((req: any, res: any) => void)) {
      state.requestHandler = handler
    },
    serverOn: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'request') state.requestHandler = handler
    })
  }
})

vi.mock('node:http', () => ({
  default: {
    createServer: vi.fn(() => ({
      listen: loopback.listen,
      address: loopback.address,
      close: loopback.close,
      on: loopback.serverOn
    })),
    get: loopback.httpGet
  }
}))

vi.mock('node:https', () => ({
  default: {
    get: loopback.httpsGet
  }
}))

const mockGetAllWindows = vi.fn().mockReturnValue([])
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows()
  },
  shell: {
    openExternal: (...args: unknown[]) => loopback.shellOpenExternal(...args)
  }
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    ready: Promise.resolve(),
    to_base64: vi.fn(() => 'base64-encoded'),
    from_base64: vi.fn(() => new Uint8Array(16)),
    base64_variants: { ORIGINAL: 0 }
  }
}))

import {
  registerAuthOAuthHandlers,
  unregisterAuthOAuthHandlers,
  seedOAuthSession
} from './auth-oauth-handlers'

// ============================================================================
// Tests
// ============================================================================

describe('auth-oauth handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    mockStoreGet.mockReturnValue({})
    mockStoreToken.mockResolvedValue(undefined)
    mockRefreshAccessToken.mockResolvedValue(true)
    mockTeardownSession.mockResolvedValue({ success: true, keychainFailures: [] })
    mockGetSyncEngine.mockReturnValue(null)
    mockStartSyncRuntime.mockResolvedValue(undefined)
    mockStartGoogleRunner.mockResolvedValue(undefined)
    loopback.requestHandler = undefined
    loopback.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback()
    })
    loopback.address.mockReturnValue({ port: 4321 })
    loopback.close.mockImplementation((callback?: () => void) => {
      callback?.()
    })
    loopback.httpGet.mockImplementation((_url: string, callback: (res: any) => void) => {
      callback({
        headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state' },
        resume: vi.fn()
      })
      return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() }
    })
    loopback.httpsGet.mockImplementation((_url: string, callback: (res: any) => void) => {
      callback({
        headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state' },
        resume: vi.fn()
      })
      return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() }
    })
    loopback.shellOpenExternal.mockResolvedValue(undefined)
  })

  afterEach(() => {
    unregisterAuthOAuthHandlers()
  })

  // --------------------------------------------------------------------------
  // T072: OAuth initiation
  // --------------------------------------------------------------------------

  describe('AUTH_INIT_OAUTH', () => {
    it('opens the provider URL and relays successful loopback callbacks', async () => {
      const send = vi.fn()
      mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])
      registerAuthOAuthHandlers()

      const result = await invokeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH, { provider: 'google' })

      expect(result).toEqual({ state: 'oauth-state' })
      expect(loopback.shellOpenExternal).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state'
      )

      const res = { writeHead: vi.fn(), end: vi.fn() }
      loopback.requestHandler?.({ url: '/callback?code=google-code&state=oauth-state' }, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/html; charset=utf-8'
      })
      expect(send).toHaveBeenCalledWith(SYNC_EVENTS.OAUTH_CALLBACK, {
        code: 'google-code',
        state: 'oauth-state'
      })
      expect(loopback.close).toHaveBeenCalled()
    })

    it('resolves the sync server URL at call time, not module import (staging regression)', async () => {
      // Regression: SYNC_SERVER_URL was captured in a module-level const that
      // evaluated before dotenv loaded .env.staging in index.ts, so dev:staging
      // silently hit http://localhost:8787 and OAuth init failed with
      // "Failed to start Google sign-in". The URL must be read per call.
      const original = process.env.SYNC_SERVER_URL
      process.env.SYNC_SERVER_URL = 'http://sync-staging.test'
      try {
        registerAuthOAuthHandlers()
        await invokeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH, { provider: 'google' })

        expect(loopback.httpGet).toHaveBeenCalledWith(
          expect.stringContaining('http://sync-staging.test/auth/oauth/google'),
          expect.any(Function)
        )
      } finally {
        if (original === undefined) delete process.env.SYNC_SERVER_URL
        else process.env.SYNC_SERVER_URL = original
      }
    })

    it('relays OAuth errors and rejects malformed provider responses', async () => {
      const send = vi.fn()
      mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])
      registerAuthOAuthHandlers()

      await invokeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH, { provider: 'google' })
      const res = { writeHead: vi.fn(), end: vi.fn() }
      loopback.requestHandler?.({ url: '/callback?error=access_denied&state=oauth-state' }, res)

      expect(send).toHaveBeenCalledWith(SYNC_EVENTS.OAUTH_ERROR, { error: 'access_denied' })
      expect(loopback.close).toHaveBeenCalled()

      unregisterAuthOAuthHandlers()
      registerAuthOAuthHandlers()
      loopback.httpGet.mockImplementationOnce((_url: string, callback: (res: any) => void) => {
        callback({ headers: {}, resume: vi.fn() })
        return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() }
      })

      const failure = await invokeHandler<{ success: false; error: string }>(
        SYNC_CHANNELS.AUTH_INIT_OAUTH,
        { provider: 'google' }
      )
      expect(failure).toEqual({ success: false, error: 'Failed to get OAuth URL from server' })
    })

    it('rejects instead of hanging when the sync server never responds', async () => {
      // Regression: a server that accepts the socket but never sends headers
      // must not leave the IPC call unsettled (the "spins forever" bug). The
      // request timeout destroys the socket and surfaces an error envelope.
      registerAuthOAuthHandlers()

      loopback.httpGet.mockImplementationOnce((_url: string, _callback: (res: any) => void) => {
        let errHandler: ((err: Error) => void) | undefined
        const req: any = {
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') errHandler = handler
            return req
          }),
          setTimeout: vi.fn((_ms: number, cb: () => void) => {
            cb()
            return req
          }),
          destroy: vi.fn((err?: Error) => {
            if (err) errHandler?.(err)
            return req
          })
        }
        return req
      })

      const failure = await invokeHandler<{ success: false; error: string }>(
        SYNC_CHANNELS.AUTH_INIT_OAUTH,
        { provider: 'google' }
      )
      expect(failure).toEqual({
        success: false,
        error: 'Timed out contacting sync server for OAuth URL'
      })
      expect(loopback.close).toHaveBeenCalled()
    })

    it('returns 404 for non-callback loopback requests', async () => {
      registerAuthOAuthHandlers()
      await invokeHandler(SYNC_CHANNELS.AUTH_INIT_OAUTH, { provider: 'google' })

      const res = { writeHead: vi.fn(), end: vi.fn() }
      loopback.requestHandler?.({ url: '/wrong-path' }, res)

      expect(res.writeHead).toHaveBeenCalledWith(404)
      expect(res.end).toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // T057: Setup First Device (OAuth)
  // --------------------------------------------------------------------------

  describe('SETUP_FIRST_DEVICE', () => {
    it('performs setup via OAuth when needsSetup is true', async () => {
      // #given
      registerAuthOAuthHandlers()
      seedOAuthSession('test-state', 'http://127.0.0.1:9999/callback')

      mockPostToServer.mockResolvedValueOnce({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'oauth-setup-token'
      })
      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'oauth recovery phrase',
        seed: new Uint8Array(64).fill(4)
      })
      mockGenerateSalt.mockReturnValue(new Uint8Array(16).fill(3))
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: new Uint8Array(32).fill(1),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        deviceId: 'dev-oauth',
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64).fill(2)
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValue('dev-oauth')

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
        oauthToken: 'google-code',
        provider: 'google',
        state: 'test-state'
      })

      // #then
      expect(result).toEqual({
        success: true,
        needsRecoverySetup: true,
        deviceId: 'dev-oauth'
      })
    })

    it('returns recovery input needed when setup not needed', async () => {
      // #given
      registerAuthOAuthHandlers()
      seedOAuthSession('test-state-2', 'http://127.0.0.1:9999/callback')
      mockPostToServer.mockResolvedValue({
        success: true,
        userId: 'user-1',
        isNewUser: false,
        needsSetup: false,
        setupToken: 'token'
      })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
        oauthToken: 'google-code',
        provider: 'google',
        state: 'test-state-2'
      })

      // #then
      expect(result).toEqual({ success: true, needsRecoverySetup: true, needsRecoveryInput: true })
    })

    it('does not activate sync engine during first device setup', async () => {
      // #given
      const mockActivate = vi.fn().mockResolvedValue(undefined)
      mockGetSyncEngine.mockReturnValue({ activate: mockActivate } as never)
      registerAuthOAuthHandlers()
      seedOAuthSession('test-state-3', 'http://127.0.0.1:9999/callback')

      mockPostToServer.mockResolvedValueOnce({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'setup-token'
      })
      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'phrase',
        seed: new Uint8Array(64)
      })
      mockGenerateSalt.mockReturnValue(new Uint8Array(16))
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: new Uint8Array(32),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        deviceId: 'dev-1',
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64)
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValue('dev-1')

      // #when
      await invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
        oauthToken: 'google-code',
        provider: 'google',
        state: 'test-state-3'
      })

      // #then
      expect(mockActivate).not.toHaveBeenCalled()
    })

    it('keeps generated recovery phrase readable until confirmation', async () => {
      registerAuthOAuthHandlers()
      seedOAuthSession('phrase-state', 'http://127.0.0.1:9999/callback')
      mockPostToServer.mockResolvedValueOnce({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'setup-token'
      })
      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'repeatable recovery phrase',
        seed: new Uint8Array(64)
      })
      mockGenerateSalt.mockReturnValue(new Uint8Array(16))
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: new Uint8Array(32),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64)
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValue('dev-1')

      await invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
        oauthToken: 'google-code',
        provider: 'google',
        state: 'phrase-state'
      })

      await expect(invokeHandler(SYNC_CHANNELS.GET_RECOVERY_PHRASE)).resolves.toBe(
        'repeatable recovery phrase'
      )
      await expect(invokeHandler(SYNC_CHANNELS.GET_RECOVERY_PHRASE)).resolves.toBe(
        'repeatable recovery phrase'
      )
    })

    it('returns structured errors for invalid state and missing setup token', async () => {
      registerAuthOAuthHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
          oauthToken: 'google-code',
          provider: 'google',
          state: 'missing-state'
        })
      ).resolves.toEqual({
        success: false,
        error: 'Invalid or expired OAuth state parameter'
      })

      seedOAuthSession('missing-token', 'http://127.0.0.1:9999/callback')
      mockPostToServer.mockResolvedValueOnce({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true
      })

      await expect(
        invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
          oauthToken: 'google-code',
          provider: 'google',
          state: 'missing-token'
        })
      ).resolves.toEqual({
        success: false,
        error: 'OAuth callback missing setupToken'
      })
    })
  })

  // --------------------------------------------------------------------------
  // T062: Recovery Phrase Confirmation
  // --------------------------------------------------------------------------

  describe('CONFIRM_RECOVERY_PHRASE', () => {
    it('persists confirmation when confirmed is true', async () => {
      // #given
      registerAuthOAuthHandlers()

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, {
        confirmed: true
      })

      // #then
      expect(result).toEqual({ success: true })
      expect(mockStoreSet).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ recoveryPhraseConfirmed: true })
      )
    })

    it('does not persist when confirmed is false', async () => {
      // #given
      registerAuthOAuthHandlers()

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, {
        confirmed: false
      })

      // #then
      expect(result).toEqual({ success: true })
      expect(mockStoreSet).not.toHaveBeenCalled()
    })

    it('activates sync engine when confirmed is true', async () => {
      // #given
      const mockActivate = vi.fn().mockResolvedValue(undefined)
      mockGetSyncEngine.mockReturnValue({ activate: mockActivate } as never)
      registerAuthOAuthHandlers()

      // #when
      await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, { confirmed: true })

      // #then
      expect(mockActivate).toHaveBeenCalledOnce()
    })

    it('does not activate sync engine when confirmed is false', async () => {
      // #given
      const mockActivate = vi.fn().mockResolvedValue(undefined)
      mockGetSyncEngine.mockReturnValue({ activate: mockActivate } as never)
      registerAuthOAuthHandlers()

      // #when
      await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, { confirmed: false })

      // #then
      expect(mockActivate).not.toHaveBeenCalled()
    })

    it('clears pending recovery phrase after confirmation', async () => {
      registerAuthOAuthHandlers()
      seedOAuthSession('confirm-clears-state', 'http://127.0.0.1:9999/callback')
      mockPostToServer.mockResolvedValueOnce({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'setup-token'
      })
      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'phrase cleared after confirmation',
        seed: new Uint8Array(64)
      })
      mockGenerateSalt.mockReturnValue(new Uint8Array(16))
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: new Uint8Array(32),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64)
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValue('dev-1')

      await invokeHandler(SYNC_CHANNELS.SETUP_FIRST_DEVICE, {
        oauthToken: 'google-code',
        provider: 'google',
        state: 'confirm-clears-state'
      })
      await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, { confirmed: true })

      await expect(invokeHandler(SYNC_CHANNELS.GET_RECOVERY_PHRASE)).resolves.toBeNull()
    })

    it('starts sync runtime and calendar runner when no engine exists', async () => {
      registerAuthOAuthHandlers()

      const result = await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, {
        confirmed: true
      })

      expect(result).toEqual({ success: true })
      expect(mockStartSyncRuntime).toHaveBeenCalledOnce()
      expect(mockStartGoogleRunner).toHaveBeenCalledOnce()
    })
  })

  describe('AUTH_REFRESH_TOKEN and AUTH_LOGOUT', () => {
    it('returns token refresh failures and logout keychain warnings', async () => {
      registerAuthOAuthHandlers()
      mockRefreshAccessToken.mockResolvedValueOnce(false)
      mockTeardownSession.mockResolvedValueOnce({
        success: true,
        keychainFailures: ['access-token', 'refresh-token']
      })

      await expect(invokeHandler(SYNC_CHANNELS.AUTH_REFRESH_TOKEN)).resolves.toEqual({
        success: false,
        error: 'Token refresh failed'
      })

      await expect(invokeHandler(SYNC_CHANNELS.AUTH_LOGOUT)).resolves.toEqual({
        success: true,
        keychainWarning: 'Failed to remove: access-token, refresh-token'
      })
    })
  })

  // --------------------------------------------------------------------------
  // Registration lifecycle
  // --------------------------------------------------------------------------

  describe('registration lifecycle', () => {
    it('registers all OAuth handler channels', () => {
      registerAuthOAuthHandlers()

      const channels = [
        SYNC_CHANNELS.AUTH_INIT_OAUTH,
        SYNC_CHANNELS.AUTH_REFRESH_TOKEN,
        SYNC_CHANNELS.SETUP_FIRST_DEVICE,
        SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
        SYNC_CHANNELS.GET_RECOVERY_PHRASE,
        SYNC_CHANNELS.AUTH_LOGOUT
      ]
      for (const ch of channels) {
        expect(mockIpcMain.handle).toHaveBeenCalledWith(ch, expect.any(Function))
      }
    })

    it('unregisters all OAuth handler channels', () => {
      registerAuthOAuthHandlers()
      unregisterAuthOAuthHandlers()

      const channels = [
        SYNC_CHANNELS.AUTH_INIT_OAUTH,
        SYNC_CHANNELS.AUTH_REFRESH_TOKEN,
        SYNC_CHANNELS.SETUP_FIRST_DEVICE,
        SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
        SYNC_CHANNELS.GET_RECOVERY_PHRASE,
        SYNC_CHANNELS.AUTH_LOGOUT
      ]
      for (const ch of channels) {
        expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(ch)
      }
    })
  })
})
