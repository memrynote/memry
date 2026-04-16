import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'

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
    openExternal: vi.fn().mockResolvedValue(undefined)
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
  })

  afterEach(() => {
    unregisterAuthOAuthHandlers()
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
