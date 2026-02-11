import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@shared/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

const mockPostToServer = vi.fn()
vi.mock('../sync/http-client', () => ({
  postToServer: (...args: unknown[]) => mockPostToServer(...args)
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

vi.mock('../crypto', () => ({
  storeKey: (...args: unknown[]) => mockStoreKey(...args),
  retrieveKey: (...args: unknown[]) => mockRetrieveKey(...args),
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args),
  deriveKey: (...args: unknown[]) => mockDeriveKey(...args),
  deriveMasterKey: (...args: unknown[]) => mockDeriveMasterKey(...args),
  generateDeviceSigningKeyPair: () => mockGenerateDeviceSigningKeyPair(),
  generateRecoveryPhrase: () => mockGenerateRecoveryPhrase(),
  generateSalt: () => mockGenerateSalt(),
  getDevicePublicKey: (...args: unknown[]) => mockGetDevicePublicKey(...args)
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
const mockDb = { insert: vi.fn().mockReturnValue({ values: mockInsertValues }) }
vi.mock('../database/client', () => ({
  getDatabase: () => mockDb
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
    crypto_sign_detached: vi.fn(() => new Uint8Array(64)),
    base64_variants: { ORIGINAL: 0 }
  }
}))

import { registerSyncHandlers, unregisterSyncHandlers, seedOAuthSession } from './sync-handlers'

// ============================================================================
// Constants
// ============================================================================

const ALL_SYNC_HANDLER_CHANNELS = [
  SYNC_CHANNELS.AUTH_REQUEST_OTP,
  SYNC_CHANNELS.AUTH_VERIFY_OTP,
  SYNC_CHANNELS.AUTH_RESEND_OTP,
  SYNC_CHANNELS.SETUP_FIRST_DEVICE,
  SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
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

  it('throws not-implemented for unimplemented channels', async () => {
    registerSyncHandlers()

    await expect(invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)).rejects.toThrow(
      'TRIGGER_SYNC not yet implemented'
    )
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
      expect(result).toEqual({ success: true, isNewUser: false })
    })

    it('performs first device setup for new user', async () => {
      // #given
      registerSyncHandlers()
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
          setupToken: 'setup-token-abc'
        })
        .mockResolvedValueOnce({
          success: true,
          deviceId: 'device-xyz',
          accessToken: 'access-token-123',
          refreshToken: 'refresh-token-456'
        })
        .mockResolvedValueOnce({ success: true })

      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'word1 word2 word3 word4',
        seed: fakeSeed
      })
      mockGenerateSalt.mockReturnValue(fakeSalt)
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: fakeKey,
        kdfSalt: 'base64-salt',
        keyVerifier: 'base64-verifier'
      })
      mockDeriveKey.mockResolvedValue(new Uint8Array(32).fill(5))
      mockGenerateDeviceSigningKeyPair.mockResolvedValue({
        deviceId: 'device-xyz',
        publicKey: new Uint8Array(32).fill(6),
        secretKey: fakeSecretKey
      })
      mockRetrieveKey.mockResolvedValue(fakeSecretKey)
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(7))

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
        email: 'new@example.com',
        code: '654321'
      })

      // #then
      expect(result).toEqual({
        success: true,
        isNewUser: true,
        needsRecoverySetup: true,
        recoveryPhrase: 'word1 word2 word3 word4',
        deviceId: 'device-xyz'
      })
      expect(mockStoreKey).toHaveBeenCalled()
      expect(mockSecureCleanup).toHaveBeenCalled()
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
      mockGenerateDeviceSigningKeyPair.mockResolvedValue({
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
        recoveryPhrase: 'oauth recovery phrase',
        deviceId: 'dev-oauth'
      })
    })

    it('returns success without recovery when setup not needed', async () => {
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
      expect(result).toEqual({ success: true })
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
})
