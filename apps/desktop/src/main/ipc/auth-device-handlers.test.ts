import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { SYNC_CHANNELS } from '@memry/contracts/ipc-sync'

// ============================================================================
// Mocks
// ============================================================================

const mockPostToServer = vi.fn()
const mockGetFromServer = vi.fn()
const mockDeleteFromServer = vi.fn()
const mockPatchToServer = vi.fn()
vi.mock('../sync/http-client', () => ({
  postToServer: (...args: unknown[]) => mockPostToServer(...args),
  getFromServer: (...args: unknown[]) => mockGetFromServer(...args),
  deleteFromServer: (...args: unknown[]) => mockDeleteFromServer(...args),
  patchToServer: (...args: unknown[]) => mockPatchToServer(...args),
  SyncServerError: class SyncServerError extends Error {
    statusCode: number
    serverError?: string
    constructor(msg: string, statusCode: number, serverError?: string) {
      super(msg)
      this.statusCode = statusCode
      this.serverError = serverError
    }
  }
}))

const mockSecureCleanup = vi.fn()
const mockDeriveMasterKey = vi.fn()
const mockGenerateRecoveryPhrase = vi.fn()
const mockGenerateSalt = vi.fn()
const mockGetOrCreateSigningKeyPair = vi.fn()
const mockRecoverMasterKeyFromPhrase = vi.fn()
const mockValidateKeyVerifier = vi.fn().mockReturnValue(true)
const mockValidateRecoveryPhrase = vi.fn().mockReturnValue(true)

vi.mock('../crypto', () => ({
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args),
  deriveMasterKey: (...args: unknown[]) => mockDeriveMasterKey(...args),
  getOrCreateSigningKeyPair: () => mockGetOrCreateSigningKeyPair(),
  generateRecoveryPhrase: () => mockGenerateRecoveryPhrase(),
  generateSalt: () => mockGenerateSalt(),
  recoverMasterKeyFromPhrase: (...args: unknown[]) => mockRecoverMasterKeyFromPhrase(...args),
  validateKeyVerifier: (...args: unknown[]) => mockValidateKeyVerifier(...args),
  validateRecoveryPhrase: (...args: unknown[]) => mockValidateRecoveryPhrase(...args)
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

const mockApproveDeviceLinking = vi.fn().mockResolvedValue({ success: true })
const mockCompleteLinkingQr = vi.fn().mockResolvedValue({ success: true })
const mockGetLinkingVerificationCode = vi.fn().mockResolvedValue({ code: '000000' })
const mockInitiateDeviceLinking = vi.fn().mockResolvedValue({ qrData: 'qr' })
const mockLinkViaQr = vi.fn().mockResolvedValue({ success: true })
vi.mock('../sync/linking-service', () => ({
  approveDeviceLinking: (...args: unknown[]) => mockApproveDeviceLinking(...args),
  completeLinkingQr: (...args: unknown[]) => mockCompleteLinkingQr(...args),
  getLinkingVerificationCode: (...args: unknown[]) => mockGetLinkingVerificationCode(...args),
  initiateDeviceLinking: (...args: unknown[]) => mockInitiateDeviceLinking(...args),
  linkViaQr: (...args: unknown[]) => mockLinkViaQr(...args)
}))

const mockSelectGet = vi.fn().mockReturnValue(undefined)
let mockSelectRows: unknown[] | null = null
const mockSelectWhere = vi.fn().mockReturnValue({
  get: mockSelectGet
})
const mockSelectFrom = vi.fn(() => {
  if (mockSelectRows) return mockSelectRows
  return {
    where: mockSelectWhere,
    all: vi.fn().mockReturnValue([])
  }
})
const mockDeleteRun = vi.fn()
const mockUpdateRun = vi.fn()
const mockDb = {
  select: vi.fn().mockReturnValue({
    from: mockSelectFrom
  }),
  delete: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ run: mockDeleteRun })
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: mockUpdateRun })
    })
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
  }
}))

const mockGetValidAccessToken = vi.fn()
const mockRetrieveToken = vi.fn()
const mockStoreToken = vi.fn()
const mockIsTokenExpired = vi.fn()
vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  isTokenExpired: (...args: unknown[]) => mockIsTokenExpired(...args),
  retrieveToken: (...args: unknown[]) => mockRetrieveToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args)
}))

import { SyncServerError } from '../sync/http-client'
import { registerAuthDeviceHandlers, unregisterAuthDeviceHandlers } from './auth-device-handlers'

// ============================================================================
// Tests
// ============================================================================

describe('auth-device handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockStoreGet.mockReturnValue({})
    mockRetrieveToken.mockResolvedValue('mock-access-token')
    mockIsTokenExpired.mockReturnValue(false)
    mockStoreToken.mockResolvedValue(undefined)
    mockGetValidAccessToken.mockResolvedValue('mock-access-token')
    mockValidateKeyVerifier.mockReturnValue(true)
    mockValidateRecoveryPhrase.mockReturnValue(true)
    mockSelectGet.mockReturnValue(undefined)
    mockSelectRows = null
    mockIsDatabaseInitialized.mockReturnValue(true)
  })

  afterEach(() => {
    unregisterAuthDeviceHandlers()
    vi.useRealTimers()
  })

  // --------------------------------------------------------------------------
  // Registration lifecycle
  // --------------------------------------------------------------------------

  describe('registration lifecycle', () => {
    const CHANNELS = [
      SYNC_CHANNELS.AUTH_REQUEST_OTP,
      SYNC_CHANNELS.AUTH_VERIFY_OTP,
      SYNC_CHANNELS.AUTH_RESEND_OTP,
      SYNC_CHANNELS.SETUP_NEW_ACCOUNT,
      SYNC_CHANNELS.GENERATE_LINKING_QR,
      SYNC_CHANNELS.LINK_VIA_QR,
      SYNC_CHANNELS.COMPLETE_LINKING_QR,
      SYNC_CHANNELS.LINK_VIA_RECOVERY,
      SYNC_CHANNELS.APPROVE_LINKING,
      SYNC_CHANNELS.GET_LINKING_SAS,
      SYNC_CHANNELS.GET_DEVICES,
      SYNC_CHANNELS.REMOVE_DEVICE,
      SYNC_CHANNELS.RENAME_DEVICE
    ]

    it('registers all auth-device channels', () => {
      registerAuthDeviceHandlers()
      for (const ch of CHANNELS) {
        expect(mockIpcMain.handle).toHaveBeenCalledWith(ch, expect.any(Function))
      }
    })

    it('unregisters all auth-device channels', () => {
      registerAuthDeviceHandlers()
      unregisterAuthDeviceHandlers()
      for (const ch of CHANNELS) {
        expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(ch)
      }
    })
  })

  // --------------------------------------------------------------------------
  // T054: Request OTP
  // --------------------------------------------------------------------------

  describe('AUTH_REQUEST_OTP', () => {
    it('calls server and returns response', async () => {
      // #given
      registerAuthDeviceHandlers()
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
      registerAuthDeviceHandlers()

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
      registerAuthDeviceHandlers()
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
      registerAuthDeviceHandlers()
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
      registerAuthDeviceHandlers()
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
      registerAuthDeviceHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.AUTH_VERIFY_OTP, {
          email: 'user@example.com',
          code: 'abc'
        })
      ).rejects.toThrow('Validation failed')
    })
  })

  // --------------------------------------------------------------------------
  // T056a: OTP Clipboard Detection
  // --------------------------------------------------------------------------

  describe('OTP clipboard detection', () => {
    it('starts clipboard polling on OTP request', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockPostToServer.mockResolvedValue({ success: true })

      // #when
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      // then clipboard polling is started - verified by advancing timers
      const mockWebContents = { send: vi.fn() }
      const mockWindow = { isDestroyed: () => false, webContents: mockWebContents }
      mockGetAllWindows.mockReturnValue([mockWindow])
      mockClipboardReadText.mockReturnValue('123456')

      vi.advanceTimersByTime(1000)

      expect(mockWebContents.send).toHaveBeenCalledWith('auth:otp-detected', { code: '123456' })
    })

    it('stops clipboard polling on OTP verify success', async () => {
      // #given
      registerAuthDeviceHandlers()
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
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: mockWebContents }
      ])
      mockClipboardReadText.mockReturnValue('654321')

      vi.advanceTimersByTime(2000)

      // #then - no more clipboard events after verify
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })

    it('ignores non-6-digit clipboard content', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockPostToServer.mockResolvedValue({ success: true })
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      const mockWebContents = { send: vi.fn() }
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: mockWebContents }
      ])
      mockClipboardReadText.mockReturnValue('not-a-code')

      // #when
      vi.advanceTimersByTime(1000)

      // #then
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })

    it('stops polling after 10 minute timeout', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockPostToServer.mockResolvedValue({ success: true })
      await invokeHandler(SYNC_CHANNELS.AUTH_REQUEST_OTP, { email: 'user@example.com' })

      // #when - advance past 10-minute timeout
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000)

      const mockWebContents = { send: vi.fn() }
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: mockWebContents }
      ])
      mockClipboardReadText.mockReturnValue('123456')

      vi.advanceTimersByTime(2000)

      // #then - no events after timeout
      expect(mockWebContents.send).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // SETUP_NEW_ACCOUNT
  // --------------------------------------------------------------------------

  describe('SETUP_NEW_ACCOUNT', () => {
    it('returns error when no setup token in keychain', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockRetrieveToken.mockResolvedValueOnce(null)

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.SETUP_NEW_ACCOUNT)

      // #then
      expect(result).toEqual({
        success: false,
        error:
          'Your sign-in timed out before this finished. Sign in again, then enter your recovery phrase.'
      })
    })

    it('performs first-device setup when setup token present', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockRetrieveToken.mockResolvedValue('setup-token')
      mockStoreGet.mockReturnValue({ email: 'user@example.com' })
      mockGenerateRecoveryPhrase.mockResolvedValue({
        phrase: 'recovery phrase',
        seed: new Uint8Array(64).fill(1)
      })
      mockGenerateSalt.mockReturnValue(new Uint8Array(16).fill(2))
      mockDeriveMasterKey.mockResolvedValue({
        masterKey: new Uint8Array(32).fill(3),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValue({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64).fill(4)
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValue('dev-1')

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.SETUP_NEW_ACCOUNT)

      // #then
      expect(result).toEqual({ success: true, deviceId: 'dev-1' })
      expect(mockStoreSet).toHaveBeenCalledWith('sync', {
        email: 'user@example.com',
        recoveryPhraseConfirmed: false
      })
    })
  })

  // --------------------------------------------------------------------------
  // Device linking
  // --------------------------------------------------------------------------

  describe('device linking', () => {
    it('generates QR linking sessions and blocks unauthenticated devices', async () => {
      registerAuthDeviceHandlers()

      await expect(invokeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)).resolves.toEqual({
        qrData: 'qr'
      })
      expect(mockInitiateDeviceLinking).toHaveBeenCalledWith('mock-access-token')

      mockGetValidAccessToken.mockResolvedValueOnce(null)

      await expect(invokeHandler(SYNC_CHANNELS.GENERATE_LINKING_QR)).rejects.toThrow(
        'Not authenticated'
      )
    })

    it('links via QR with OAuth token, setup token fallback, and missing-token failure', async () => {
      registerAuthDeviceHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_QR, {
          qrData: 'qr-payload',
          oauthToken: 'oauth-token',
          provider: 'google'
        })
      ).resolves.toEqual({ success: true })
      expect(mockLinkViaQr).toHaveBeenLastCalledWith('qr-payload', 'oauth-token')

      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_QR, { qrData: 'qr-fallback' })
      ).resolves.toEqual({ success: true })
      expect(mockLinkViaQr).toHaveBeenLastCalledWith('qr-fallback', 'mock-access-token')

      mockRetrieveToken.mockResolvedValueOnce(null)

      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_QR, { qrData: 'qr-missing-token' })
      ).resolves.toEqual({
        success: false,
        error: 'No auth token available for device linking'
      })
    })

    it('completes QR linking, approval, and SAS flows', async () => {
      registerAuthDeviceHandlers()

      await expect(
        invokeHandler(SYNC_CHANNELS.COMPLETE_LINKING_QR, { sessionId: 'session-1' })
      ).resolves.toEqual({ success: true })
      expect(mockCompleteLinkingQr).toHaveBeenCalledWith('session-1')

      await expect(
        invokeHandler(SYNC_CHANNELS.APPROVE_LINKING, { sessionId: 'session-2' })
      ).resolves.toEqual({ success: true })
      expect(mockApproveDeviceLinking).toHaveBeenCalledWith('session-2', 'mock-access-token')

      await expect(
        invokeHandler(SYNC_CHANNELS.GET_LINKING_SAS, { sessionId: 'session-3' })
      ).resolves.toEqual({ code: '000000' })
      expect(mockGetLinkingVerificationCode).toHaveBeenCalledWith('session-3', 'mock-access-token')

      mockGetValidAccessToken.mockResolvedValueOnce(null)
      await expect(
        invokeHandler(SYNC_CHANNELS.APPROVE_LINKING, { sessionId: 'session-4' })
      ).resolves.toEqual({ success: false, error: 'Not authenticated' })

      mockGetValidAccessToken.mockResolvedValueOnce(null)
      await expect(
        invokeHandler(SYNC_CHANNELS.GET_LINKING_SAS, { sessionId: 'session-5' })
      ).resolves.toEqual({ success: false, error: 'Not authenticated' })
    })

    it('links via recovery phrase and cleans up derived secrets', async () => {
      registerAuthDeviceHandlers()
      const masterKey = new Uint8Array(32).fill(7)
      const signingSecretKey = new Uint8Array(64).fill(8)

      mockGetFromServer.mockResolvedValueOnce({ kdfSalt: 'salt', keyVerifier: 'verifier' })
      mockRecoverMasterKeyFromPhrase.mockResolvedValueOnce({
        masterKey,
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValueOnce({
        publicKey: new Uint8Array(32),
        secretKey: signingSecretKey
      })
      mockPersistKeysAndRegisterDevice.mockResolvedValueOnce('recovered-device')

      const result = await invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, {
        recoveryPhrase: 'correct horse battery staple'
      })

      expect(result).toEqual({ success: true, deviceId: 'recovered-device' })
      expect(mockGetFromServer).toHaveBeenCalledWith('/auth/recovery-info', 'mock-access-token')
      expect(mockPersistKeysAndRegisterDevice).toHaveBeenCalledWith(
        masterKey,
        signingSecretKey,
        'mock-access-token',
        'salt',
        'verifier',
        true
      )
      expect(mockSecureCleanup).toHaveBeenCalledWith(masterKey)
      expect(mockSecureCleanup).toHaveBeenCalledWith(signingSecretKey)
    })

    it('reports setup-token failures as a sign-in timeout, never the server wording', async () => {
      // #given — the sentence a user can act on (#1202: they saw "Invalid setup token")
      registerAuthDeviceHandlers()
      const timedOut = {
        success: false,
        error:
          'Your sign-in timed out before this finished. Sign in again, then enter your recovery phrase.'
      }
      const phrase = { recoveryPhrase: 'correct horse battery staple' }

      // #when — the five-minute token already ran out while the user hunted for their phrase
      mockIsTokenExpired.mockReturnValueOnce(true)

      // #then — answered locally, no pointless round trip
      await expect(invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, phrase)).resolves.toEqual(
        timedOut
      )
      expect(mockGetFromServer).not.toHaveBeenCalled()

      // #when / #then — the server's own 401 wording is translated, not forwarded
      mockGetFromServer.mockRejectedValueOnce(
        new SyncServerError('Invalid setup token', 401, 'AUTH_INVALID_TOKEN: Invalid setup token')
      )
      await expect(invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, phrase)).resolves.toEqual(
        timedOut
      )

      // #when / #then — same for a token already consumed by a device registration
      mockGetFromServer.mockResolvedValueOnce({ kdfSalt: 'salt', keyVerifier: 'verifier' })
      mockRecoverMasterKeyFromPhrase.mockResolvedValueOnce({
        masterKey: new Uint8Array(32).fill(3),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
      mockGetOrCreateSigningKeyPair.mockResolvedValueOnce({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64)
      })
      mockPersistKeysAndRegisterDevice.mockRejectedValueOnce(
        new SyncServerError('Setup token already used', 401)
      )
      await expect(invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, phrase)).resolves.toEqual(
        timedOut
      )
    })

    it('returns recovery-linking validation and verifier failures without registering a device', async () => {
      registerAuthDeviceHandlers()

      mockValidateRecoveryPhrase.mockReturnValueOnce(false)
      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, { recoveryPhrase: 'bad' })
      ).resolves.toEqual({ success: false, error: 'Invalid recovery phrase format' })

      mockRetrieveToken.mockResolvedValueOnce(null)
      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, {
          recoveryPhrase: 'correct horse battery staple'
        })
      ).resolves.toEqual({
        success: false,
        error:
          'Your sign-in timed out before this finished. Sign in again, then enter your recovery phrase.'
      })

      mockGetFromServer.mockResolvedValueOnce({ kdfSalt: 'salt', keyVerifier: 'verifier' })
      mockRecoverMasterKeyFromPhrase.mockResolvedValueOnce({
        masterKey: new Uint8Array(32).fill(9),
        kdfSalt: 'salt',
        keyVerifier: 'wrong-verifier'
      })
      mockValidateKeyVerifier.mockReturnValueOnce(false)

      await expect(
        invokeHandler(SYNC_CHANNELS.LINK_VIA_RECOVERY, {
          recoveryPhrase: 'correct horse battery staple'
        })
      ).resolves.toEqual({
        success: false,
        error: 'Recovery phrase does not match. Please try again.'
      })
      expect(mockPersistKeysAndRegisterDevice).not.toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.any(Uint8Array),
        expect.any(String),
        expect.any(String),
        'wrong-verifier',
        true
      )
    })
  })

  // --------------------------------------------------------------------------
  // GET_DEVICES
  // --------------------------------------------------------------------------

  describe('GET_DEVICES', () => {
    it('returns an empty device list when the database is not initialized', async () => {
      registerAuthDeviceHandlers()
      mockIsDatabaseInitialized.mockReturnValueOnce(false)

      await expect(invokeHandler(SYNC_CHANNELS.GET_DEVICES)).resolves.toEqual({
        devices: [],
        email: undefined,
        needsRecoveryConfirmation: false
      })
    })

    it('maps persisted devices and sync email for the renderer', async () => {
      registerAuthDeviceHandlers()
      mockGetValidAccessToken.mockResolvedValue(null)
      mockStoreGet.mockReturnValueOnce({ email: 'user@example.com' })
      mockSelectRows = [
        {
          id: 'dev-1',
          name: 'Kaan MBP',
          platform: 'macos',
          linkedAt: new Date('2026-05-01T10:00:00.000Z'),
          lastSyncAt: new Date('2026-05-02T10:00:00.000Z'),
          isCurrentDevice: true
        },
        {
          id: 'dev-2',
          name: 'Linux box',
          platform: 'linux',
          linkedAt: new Date('2026-05-03T10:00:00.000Z'),
          lastSyncAt: null,
          isCurrentDevice: false
        }
      ]

      await expect(invokeHandler(SYNC_CHANNELS.GET_DEVICES)).resolves.toEqual({
        email: 'user@example.com',
        needsRecoveryConfirmation: false,
        devices: [
          {
            id: 'dev-1',
            name: 'Kaan MBP',
            platform: 'macos',
            linkedAt: new Date('2026-05-01T10:00:00.000Z').getTime(),
            lastSyncAt: new Date('2026-05-02T10:00:00.000Z').getTime(),
            isCurrentDevice: true
          },
          {
            id: 'dev-2',
            name: 'Linux box',
            platform: 'linux',
            linkedAt: new Date('2026-05-03T10:00:00.000Z').getTime(),
            lastSyncAt: undefined,
            isCurrentDevice: false
          }
        ]
      })
    })

    it('reports pending recovery confirmation from local sync state', async () => {
      registerAuthDeviceHandlers()
      mockGetValidAccessToken.mockResolvedValue(null)
      mockStoreGet.mockReturnValueOnce({
        email: 'user@example.com',
        recoveryPhraseConfirmed: false
      })
      mockSelectRows = [
        {
          id: 'dev-1',
          name: 'Kaan MBP',
          platform: 'macos',
          linkedAt: new Date('2026-05-01T10:00:00.000Z'),
          lastSyncAt: null,
          isCurrentDevice: true
        }
      ]

      await expect(invokeHandler(SYNC_CHANNELS.GET_DEVICES)).resolves.toMatchObject({
        email: 'user@example.com',
        needsRecoveryConfirmation: true,
        devices: [{ id: 'dev-1', isCurrentDevice: true }]
      })
    })

    it('refreshes active devices from the sync server when authenticated', async () => {
      registerAuthDeviceHandlers()
      mockStoreGet.mockReturnValueOnce({ email: 'user@example.com' })
      mockSelectRows = [
        {
          id: 'dev-1',
          name: 'Kaan MBP',
          platform: 'macos',
          linkedAt: new Date('2026-05-01T10:00:00.000Z'),
          lastSyncAt: null,
          isCurrentDevice: true
        }
      ]
      mockGetFromServer.mockResolvedValueOnce({
        devices: [
          {
            id: 'dev-1',
            name: 'Kaan MBP',
            platform: 'macos',
            createdAt: 1777629600,
            lastSyncAt: 1777716000
          },
          {
            id: 'dev-2',
            name: 'Linux box',
            platform: 'linux',
            createdAt: 1777802400,
            lastSyncAt: null
          }
        ]
      })

      await expect(invokeHandler(SYNC_CHANNELS.GET_DEVICES)).resolves.toEqual({
        email: 'user@example.com',
        needsRecoveryConfirmation: false,
        devices: [
          {
            id: 'dev-1',
            name: 'Kaan MBP',
            platform: 'macos',
            linkedAt: 1777629600000,
            lastSyncAt: 1777716000000,
            isCurrentDevice: true
          },
          {
            id: 'dev-2',
            name: 'Linux box',
            platform: 'linux',
            linkedAt: 1777802400000,
            lastSyncAt: undefined,
            isCurrentDevice: false
          }
        ]
      })
      expect(mockGetFromServer).toHaveBeenCalledWith('/devices', 'mock-access-token')
    })
  })

  // --------------------------------------------------------------------------
  // REMOVE_DEVICE
  // --------------------------------------------------------------------------

  describe('REMOVE_DEVICE', () => {
    it('refuses to remove the current device', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockSelectGet.mockReturnValue({ id: 'dev-current' })

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.REMOVE_DEVICE, { deviceId: 'dev-current' })

      // #then
      expect(result).toEqual({ success: false, error: 'Cannot remove the current device' })
      expect(mockDeleteFromServer).not.toHaveBeenCalled()
    })

    it('returns error when not authenticated', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockSelectGet.mockReturnValue({ id: 'dev-other' })
      mockGetValidAccessToken.mockResolvedValueOnce(null)

      // #when
      const result = await invokeHandler(SYNC_CHANNELS.REMOVE_DEVICE, { deviceId: 'dev-remote' })

      // #then
      expect(result).toEqual({ success: false, error: 'Not authenticated' })
    })

    it('removes remote devices locally without revoking the current renderer, and tolerates server 404s', async () => {
      registerAuthDeviceHandlers()
      const send = vi.fn()
      mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])

      await expect(
        invokeHandler(SYNC_CHANNELS.REMOVE_DEVICE, { deviceId: 'dev-remote' })
      ).resolves.toEqual({ success: true })

      expect(mockDeleteFromServer).toHaveBeenCalledWith('/devices/dev-remote', 'mock-access-token')
      expect(mockDeleteRun).toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()

      mockDeleteFromServer.mockRejectedValueOnce(new Error('404 not found'))

      await expect(
        invokeHandler(SYNC_CHANNELS.REMOVE_DEVICE, { deviceId: 'already-gone' })
      ).resolves.toEqual({ success: true })
    })

    it('returns a server error for non-404 remove failures', async () => {
      registerAuthDeviceHandlers()
      mockDeleteFromServer.mockRejectedValueOnce(new Error('500 unavailable'))

      await expect(
        invokeHandler(SYNC_CHANNELS.REMOVE_DEVICE, { deviceId: 'dev-remote' })
      ).resolves.toEqual({ success: false, error: 'Server error: 500 unavailable' })
      expect(mockDeleteRun).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // RENAME_DEVICE
  // --------------------------------------------------------------------------

  describe('RENAME_DEVICE', () => {
    it('renames a device locally and broadcasts the new name', async () => {
      registerAuthDeviceHandlers()
      const send = vi.fn()
      mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])

      await expect(
        invokeHandler(SYNC_CHANNELS.RENAME_DEVICE, {
          deviceId: 'dev-remote',
          newName: 'Travel laptop'
        })
      ).resolves.toEqual({ success: true })

      expect(mockPatchToServer).toHaveBeenCalledWith(
        '/devices/dev-remote',
        { name: 'Travel laptop' },
        'mock-access-token'
      )
      expect(mockUpdateRun).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith('sync:device-renamed', {
        deviceId: 'dev-remote',
        name: 'Travel laptop'
      })
    })

    it('returns auth and server errors without local updates', async () => {
      registerAuthDeviceHandlers()

      mockGetValidAccessToken.mockResolvedValueOnce(null)
      await expect(
        invokeHandler(SYNC_CHANNELS.RENAME_DEVICE, {
          deviceId: 'dev-remote',
          newName: 'Travel laptop'
        })
      ).resolves.toEqual({ success: false, error: 'Not authenticated' })

      mockPatchToServer.mockRejectedValueOnce(new Error('503 unavailable'))
      await expect(
        invokeHandler(SYNC_CHANNELS.RENAME_DEVICE, {
          deviceId: 'dev-remote',
          newName: 'Travel laptop'
        })
      ).resolves.toEqual({ success: false, error: 'Server error: 503 unavailable' })
      expect(mockUpdateRun).not.toHaveBeenCalled()
    })
  })
})
