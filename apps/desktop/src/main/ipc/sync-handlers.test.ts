import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

const mockPostToServer = vi.fn()
const mockGetFromServer = vi.fn()
const mockDeleteFromServer = vi.fn()
vi.mock('../sync/http-client', () => ({
  postToServer: (...args: unknown[]) => mockPostToServer(...args),
  getFromServer: (...args: unknown[]) => mockGetFromServer(...args),
  deleteFromServer: (...args: unknown[]) => mockDeleteFromServer(...args),
  SyncServerError: class SyncServerError extends Error {
    status: number
    constructor(msg: string, status: number) {
      super(msg)
      this.status = status
    }
  }
}))

const mockStoreKey = vi.fn()
const mockRetrieveKey = vi.fn()
const mockSecureCleanup = vi.fn()
const mockDeriveKey = vi.fn()
const mockDeriveMasterKey = vi.fn()
const mockGenerateDeviceSigningKeyPair = vi.fn()
const mockGenerateRecoveryPhrase = vi.fn()
const mockGenerateSalt = vi.fn()
const mockGetDevicePublicKey = vi.fn()
const mockGetOrCreateSigningKeyPair = vi.fn()

vi.mock('../crypto', () => ({
  storeKey: (...args: unknown[]) => mockStoreKey(...args),
  retrieveKey: (...args: unknown[]) => mockRetrieveKey(...args),
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args),
  deriveKey: (...args: unknown[]) => mockDeriveKey(...args),
  deriveMasterKey: (...args: unknown[]) => mockDeriveMasterKey(...args),
  generateDeviceSigningKeyPair: () => mockGenerateDeviceSigningKeyPair(),
  getOrCreateSigningKeyPair: () => mockGetOrCreateSigningKeyPair(),
  generateRecoveryPhrase: () => mockGenerateRecoveryPhrase(),
  generateSalt: () => mockGenerateSalt(),
  getDevicePublicKey: (...args: unknown[]) => mockGetDevicePublicKey(...args),
  deleteKey: vi.fn().mockResolvedValue(undefined),
  phraseToSeed: vi.fn().mockResolvedValue(new Uint8Array(64)),
  validateRecoveryPhrase: vi.fn().mockReturnValue(true),
  constantTimeEqual: vi.fn().mockReturnValue(true)
}))

const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('../store', () => ({
  store: {
    get: (...args: unknown[]) => mockStoreGet(...args),
    set: (...args: unknown[]) => mockStoreSet(...args)
  }
}))

const mockInsertValues = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) })
const mockUpdateRun = vi.fn()
const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockReturnValue({ run: mockUpdateRun })
})
const mockSelectGet = vi.fn().mockReturnValue(undefined)

const createWhereResult = (defaultValue: unknown = undefined) => {
  const result = Promise.resolve(defaultValue)
  ;(result as Record<string, unknown>).get = mockSelectGet
  ;(result as Record<string, unknown>).run = vi.fn()
  return result
}

const mockDeleteWhere = vi.fn().mockImplementation(() => createWhereResult())
const mockDb = {
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({ run: vi.fn() })
  }),
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => createWhereResult([])),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          offset: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) })
        })
      }),
      all: vi.fn().mockReturnValue([])
    })
  }),
  delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
  update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
  transaction: vi.fn((fn: (tx: unknown) => void) => {
    fn(mockDb)
  })
}
const mockIsDatabaseInitialized = vi.fn().mockReturnValue(true)
vi.mock('../database/client', () => ({
  getDatabase: () => mockDb,
  isDatabaseInitialized: () => mockIsDatabaseInitialized()
}))

const mockClipboardReadText = vi.fn().mockReturnValue('')
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
  clipboard: {
    readText: () => mockClipboardReadText()
  },
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows()
  },
  app: {
    getVersion: () => '1.0.0'
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('os', () => ({
  default: {
    hostname: () => 'test-machine',
    release: () => '14.0.0'
  }
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    ready: Promise.resolve(),
    to_base64: vi.fn(() => 'base64-encoded'),
    from_base64: vi.fn(() => new Uint8Array(16)),
    crypto_sign_detached: vi.fn(() => new Uint8Array(64)),
    base64_variants: { ORIGINAL: 0 }
  }
}))

vi.mock('jose', () => ({
  decodeJwt: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600, jti: 'test-jti' }))
}))

vi.mock('../sync/settings-sync', () => ({
  getSettingsSyncManager: vi.fn().mockReturnValue(null)
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: vi.fn().mockReturnValue(null)
}))

const mockGetValidAccessToken = vi.fn()
const mockRetrieveToken = vi.fn()
const mockStoreToken = vi.fn()
const mockExtractJtiFromToken = vi.fn().mockReturnValue('test-jti')
const mockScheduleTokenRefresh = vi.fn()
const mockCancelTokenRefresh = vi.fn()
const mockRefreshAccessToken = vi.fn()
vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  retrieveToken: (...args: unknown[]) => mockRetrieveToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
  extractJtiFromToken: (...args: unknown[]) => mockExtractJtiFromToken(...args),
  scheduleTokenRefresh: (...args: unknown[]) => mockScheduleTokenRefresh(...args),
  cancelTokenRefresh: (...args: unknown[]) => mockCancelTokenRefresh(...args),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  ACCESS_TOKEN_EXPIRY_SECONDS: 900
}))

import {
  registerSyncHandlers,
  unregisterSyncHandlers,
  seedOAuthSession,
  checkSyncIntegrity
} from './sync-handlers'
import { getSyncEngine } from '../sync/runtime'

const mockGetSyncEngine = vi.mocked(getSyncEngine)

// ============================================================================
// Constants
// ============================================================================

const ALL_SYNC_HANDLER_CHANNELS = [
  SYNC_CHANNELS.AUTH_REQUEST_OTP,
  SYNC_CHANNELS.AUTH_VERIFY_OTP,
  SYNC_CHANNELS.AUTH_RESEND_OTP,
  SYNC_CHANNELS.AUTH_INIT_OAUTH,
  SYNC_CHANNELS.AUTH_REFRESH_TOKEN,
  SYNC_CHANNELS.SETUP_FIRST_DEVICE,
  SYNC_CHANNELS.SETUP_NEW_ACCOUNT,
  SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
  SYNC_CHANNELS.GET_RECOVERY_PHRASE,
  SYNC_CHANNELS.AUTH_LOGOUT,
  SYNC_CHANNELS.GENERATE_LINKING_QR,
  SYNC_CHANNELS.LINK_VIA_QR,
  SYNC_CHANNELS.LINK_VIA_RECOVERY,
  SYNC_CHANNELS.APPROVE_LINKING,
  SYNC_CHANNELS.GET_DEVICES,
  SYNC_CHANNELS.REMOVE_DEVICE,
  SYNC_CHANNELS.RENAME_DEVICE,
  SYNC_CHANNELS.GET_STATUS,
  SYNC_CHANNELS.TRIGGER_SYNC,
  SYNC_CHANNELS.GET_HISTORY,
  SYNC_CHANNELS.GET_QUEUE_SIZE,
  SYNC_CHANNELS.PAUSE,
  SYNC_CHANNELS.RESUME,
  SYNC_CHANNELS.UPDATE_SYNCED_SETTING,
  SYNC_CHANNELS.GET_SYNCED_SETTINGS,
  SYNC_CHANNELS.UPLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
  SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS
] as const

// ============================================================================
// Tests
// ============================================================================

describe('sync IPC handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockStoreGet.mockReturnValue({})
    mockRetrieveToken.mockResolvedValue('mock-access-token')
    mockStoreToken.mockResolvedValue(undefined)
    mockGetValidAccessToken.mockResolvedValue('mock-access-token')
    mockRefreshAccessToken.mockResolvedValue(true)
    mockExtractJtiFromToken.mockReturnValue('test-jti')
  })

  afterEach(() => {
    unregisterSyncHandlers()
    vi.useRealTimers()
  })

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  it('registers handlers for all sync channels', () => {
    registerSyncHandlers()

    for (const channel of ALL_SYNC_HANDLER_CHANNELS) {
      expect(mockIpcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('unregisters all sync handlers', () => {
    registerSyncHandlers()
    unregisterSyncHandlers()

    for (const channel of ALL_SYNC_HANDLER_CHANNELS) {
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(channel)
    }
  })

  it('returns error for TRIGGER_SYNC when engine not initialized', async () => {
    registerSyncHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
    expect(result).toEqual({
      success: false,
      error: 'Sync engine not initialized. Open a vault to start sync.'
    })
  })

  // --------------------------------------------------------------------------
  // T054: Request OTP
  // --------------------------------------------------------------------------

  describe('AUTH_REQUEST_OTP', () => {
    it('calls server and returns response', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({ success: true, expiresIn: 600 })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, {
        email: 'user@example.com'
      })

      // #then
      expect(mockPostToServer).toHaveBeenCalledWith('/auth/otp/request', {
        email: 'user@example.com'
      })
      expect(result).toEqual({ success: true, expiresIn: 600 })
    })

    it('rejects invalid email', async () => {
      registerSyncHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'not-an-email' })
      ).rejects.toThrow('Validation failed')
    })
  })

  // --------------------------------------------------------------------------
  // T056: Resend OTP
  // --------------------------------------------------------------------------

  describe('AUTH_RESEND_OTP', () => {
    it('calls server resend endpoint', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({ success: true, expiresIn: 600 })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.AUTH_RESEND_OTP, {
        email: 'user@example.com'
      })

      // #then
      expect(mockPostToServer).toHaveBeenCalledWith('/auth/otp/resend', {
        email: 'user@example.com'
      })
      expect(result).toEqual({ success: true, expiresIn: 600 })
    })
  })

  // --------------------------------------------------------------------------
  // T055: Verify OTP
  // --------------------------------------------------------------------------

  describe('AUTH_VERIFY_OTP', () => {
    it('returns success for existing user without setup', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({
        success: true,
        userId: 'user-1',
        isNewUser: false,
        needsSetup: false,
        setupToken: 'setup-token-123'
      })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
        email: 'user@example.com',
        code: '123456'
      })

      // #then
      expect(mockPostToServer).toHaveBeenCalledWith('/auth/otp/verify', {
        email: 'user@example.com',
        code: '123456'
      })
      expect(result).toEqual({
        success: true,
        isNewUser: false,
        needsSetup: false,
        needsRecoveryInput: true
      })
    })

    it('returns status for new user requiring setup', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({
        success: true,
        userId: 'user-1',
        isNewUser: true,
        needsSetup: true,
        setupToken: 'setup-token-abc'
      })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
        email: 'new@example.com',
        code: '654321'
      })

      // #then
      expect(result).toEqual({
        success: true,
        isNewUser: true,
        needsSetup: true,
        needsRecoveryInput: false
      })
    })

    it('rejects invalid OTP code format', async () => {
      registerSyncHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
          email: 'user@example.com',
          code: 'abc'
        })
      ).rejects.toThrow('Validation failed')
    })
  })

  // --------------------------------------------------------------------------
  // T057: Setup First Device (OAuth)
  // --------------------------------------------------------------------------

  describe('SETUP_FIRST_DEVICE', () => {
    it('performs setup via OAuth when needsSetup is true', async () => {
      // #given
      registerSyncHandlers()
      seedOAuthSession('test-state', 'http://127.0.0.1:9999/callback')
      const fakeKey = new Uint8Array(32).fill(1)
      const fakeSecretKey = new Uint8Array(64).fill(2)
      const fakeSalt = new Uint8Array(16).fill(3)
      const fakeSeed = new Uint8Array(64).fill(4)

      mockPostToServer
        .mockResolvedValueOnce({
          success: true,
          userId: 'user-1',
          isNewUser: true,
          needsSetup: true,
          setupToken: 'oauth-setup-token'
        })
        .mockResolvedValueOnce({
          success: true,
          deviceId: 'dev-oauth',
          accessToken: 'at',
          refreshToken: 'rt'
        })
        .mockResolvedValueOnce({ success: true })

      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'oauth recovery phrase',
        seed: fakeSeed
      })
      mockGenerateSalt.mockReturnValue(fakeSalt)
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: fakeKey,
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockDeriveKey.mockResolvedValue(new Uint8Array(32))
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        deviceId: 'dev-oauth',
        publicKey: new Uint8Array(32),
        secretKey: fakeSecretKey
      })
      mockRetrieveKey.mockResolvedValue(fakeSecretKey)
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32))

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
      registerSyncHandlers()
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
      registerSyncHandlers()
      seedOAuthSession('test-state-3', 'http://127.0.0.1:9999/callback')
      const fakeKey = new Uint8Array(32).fill(1)
      const fakeSecretKey = new Uint8Array(64).fill(2)
      const fakeSalt = new Uint8Array(16).fill(3)
      const fakeSeed = new Uint8Array(64).fill(4)

      mockPostToServer
        .mockResolvedValueOnce({
          success: true,
          userId: 'user-1',
          isNewUser: true,
          needsSetup: true,
          setupToken: 'setup-token'
        })
        .mockResolvedValueOnce({
          success: true,
          deviceId: 'dev-1',
          accessToken: 'at',
          refreshToken: 'rt'
        })
        .mockResolvedValueOnce({ success: true })

      mockGenerateRecoveryPhrase.mockResolvedValue({ phrase: 'test phrase', seed: fakeSeed })
      mockGenerateSalt.mockReturnValue(fakeSalt)
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: fakeKey,
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockDeriveKey.mockResolvedValue(new Uint8Array(32))
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        deviceId: 'dev-1',
        publicKey: new Uint8Array(32),
        secretKey: fakeSecretKey
      })
      mockRetrieveKey.mockResolvedValue(fakeSecretKey)
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32))

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
      registerSyncHandlers()

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
      registerSyncHandlers()

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
      registerSyncHandlers()

      // #when
      await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, { confirmed: true })

      // #then
      expect(mockActivate).toHaveBeenCalledOnce()
    })

    it('does not activate sync engine when confirmed is false', async () => {
      // #given
      const mockActivate = vi.fn().mockResolvedValue(undefined)
      mockGetSyncEngine.mockReturnValue({ activate: mockActivate } as never)
      registerSyncHandlers()

      // #when
      await invokeHandler(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, { confirmed: false })

      // #then
      expect(mockActivate).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // T056a: OTP Clipboard Detection
  // --------------------------------------------------------------------------

  describe('OTP clipboard detection', () => {
    it('starts clipboard polling on OTP request', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({ success: true })

      // #when
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      // then clipboard polling is started - verified by advancing timers
      const mockWebContents = { send: vi.fn() }
      const mockWindow = { webContents: mockWebContents }
      mockGetAllWindows.mockReturnValue([mockWindow])
      mockClipboardReadText.mockReturnValue('123456')

      vi.advanceTimersByTime(1000)

      expect(mockWebContents.send).toHaveBeenCalledWith('auth:otp-detected', { code: '123456' })
    })

    it('stops clipboard polling on OTP verify success', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
        success: true,
        userId: 'u1',
        isNewUser: false,
        needsSetup: false,
        setupToken: 'tok'
      })

      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      // #when
      await invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
        email: 'user@example.com',
        code: '123456'
      })

      const mockWebContents = { send: vi.fn() }
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
      mockClipboardReadText.mockReturnValue('654321')

      vi.advanceTimersByTime(2000)

      // #then - no more clipboard events after verify
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })

    it('ignores non-6-digit clipboard content', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({ success: true })
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      const mockWebContents = { send: vi.fn() }
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
      mockClipboardReadText.mockReturnValue('not-a-code')

      // #when
      vi.advanceTimersByTime(1000)

      // #then
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })

    it('stops polling after 10 minute timeout', async () => {
      // #given
      registerSyncHandlers()
      mockPostToServer.mockResolvedValue({ success: true })
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      // #when - advance past 10-minute timeout
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000)

      const mockWebContents = { send: vi.fn() }
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
      mockClipboardReadText.mockReturnValue('123456')

      vi.advanceTimersByTime(2000)

      // #then - no events after timeout
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // checkSyncIntegrity — self-healing
  // --------------------------------------------------------------------------

  describe('checkSyncIntegrity', () => {
    it('skips check when database is not initialized', async () => {
      // #given
      mockIsDatabaseInitialized.mockReturnValue(false)

      // #when
      await checkSyncIntegrity()

      // #then
      expect(mockDb.select).not.toHaveBeenCalled()
    })

    it('does nothing when no current device exists', async () => {
      // #given
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue(undefined)

      // #when
      await checkSyncIntegrity()

      // #then
      expect(mockRetrieveKey).not.toHaveBeenCalled()
    })

    it('self-heals when keychain key differs from DB public key', async () => {
      // #given
      mockIsDatabaseInitialized.mockReturnValue(true)
      const device = { id: 'dev-1', signingPublicKey: 'old-pubkey-b64' }
      mockSelectGet.mockReturnValue(device)

      const fakeSigningKey = new Uint8Array(64).fill(9)
      mockRetrieveKey
        .mockResolvedValueOnce(new Uint8Array(32).fill(1))
        .mockResolvedValueOnce(fakeSigningKey)

      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(8))

      // #when
      await checkSyncIntegrity()

      // #then — should update DB, not wipe state
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockUpdateSet).toHaveBeenCalledWith({ signingPublicKey: 'base64-encoded' })
      expect(mockStoreSet).not.toHaveBeenCalled()
    })
  })
})
