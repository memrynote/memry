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

vi.mock('../sync/linking-service', () => ({
  approveDeviceLinking: vi.fn().mockResolvedValue({ success: true }),
  completeLinkingQr: vi.fn().mockResolvedValue({ success: true }),
  getLinkingVerificationCode: vi.fn().mockResolvedValue({ code: '000000' }),
  initiateDeviceLinking: vi.fn().mockResolvedValue({ qrData: 'qr' }),
  linkViaQr: vi.fn().mockResolvedValue({ success: true })
}))

const mockSelectGet = vi.fn().mockReturnValue(undefined)
const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        get: mockSelectGet
      }),
      all: vi.fn().mockReturnValue([])
    })
  }),
  delete: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ run: vi.fn() })
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() })
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
vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  retrieveToken: (...args: unknown[]) => mockRetrieveToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args)
}))

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
    mockStoreToken.mockResolvedValue(undefined)
    mockGetValidAccessToken.mockResolvedValue('mock-access-token')
    mockValidateKeyVerifier.mockReturnValue(true)
    mockValidateRecoveryPhrase.mockReturnValue(true)
    mockSelectGet.mockReturnValue(undefined)
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
      const mockWindow = { webContents: mockWebContents }
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
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
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
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
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
      mockGetAllWindows.mockReturnValue([{ webContents: mockWebContents }])
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
        error: 'Session expired. Please sign in again.'
      })
    })

    it('performs first-device setup when setup token present', async () => {
      // #given
      registerAuthDeviceHandlers()
      mockRetrieveToken.mockResolvedValue('setup-token')
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
  })
})
