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

const mockRetrieveKey = vi.fn()
const mockSecureCleanup = vi.fn()
const mockGetDevicePublicKey = vi.fn()

vi.mock('../crypto', () => ({
  retrieveKey: (...args: unknown[]) => mockRetrieveKey(...args),
  secureCleanup: (...args: unknown[]) => mockSecureCleanup(...args),
  getDevicePublicKey: (...args: unknown[]) => mockGetDevicePublicKey(...args),
  getOrDeriveVaultKey: vi.fn().mockResolvedValue(null),
  deriveMasterKey: vi.fn(),
  getOrCreateSigningKeyPair: vi.fn(),
  generateRecoveryPhrase: vi.fn(),
  generateSalt: vi.fn(),
  recoverMasterKeyFromPhrase: vi.fn(),
  validateKeyVerifier: vi.fn().mockReturnValue(true),
  validateRecoveryPhrase: vi.fn().mockReturnValue(true)
}))

const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('../store', () => ({
  store: {
    get: (...args: unknown[]) => mockStoreGet(...args),
    set: (...args: unknown[]) => mockStoreSet(...args)
  }
}))

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

vi.mock('../sync/settings-sync', () => ({
  getSettingsSyncManager: vi.fn().mockReturnValue(null)
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: vi.fn().mockReturnValue(null),
  startSyncRuntime: vi.fn(),
  getNetworkMonitor: vi.fn().mockReturnValue(null)
}))

vi.mock('../sync/session-teardown', () => ({
  teardownSession: vi.fn().mockResolvedValue({ success: true, keychainFailures: [] })
}))

vi.mock('../sync/device-registration', () => ({
  persistKeysAndRegisterDevice: vi.fn().mockResolvedValue('mock-device-id')
}))

vi.mock('../sync/linking-service', () => ({
  approveDeviceLinking: vi.fn().mockResolvedValue({ success: true }),
  completeLinkingQr: vi.fn().mockResolvedValue({ success: true }),
  getLinkingVerificationCode: vi.fn().mockResolvedValue({ code: '000000' }),
  initiateDeviceLinking: vi.fn().mockResolvedValue({ qrData: 'qr' }),
  linkViaQr: vi.fn().mockResolvedValue({ success: true })
}))

const mockGetValidAccessToken = vi.fn()
const mockRetrieveToken = vi.fn()
const mockStoreToken = vi.fn()
const mockCancelTokenRefresh = vi.fn()
const mockRefreshAccessToken = vi.fn()
vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  retrieveToken: (...args: unknown[]) => mockRetrieveToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
  cancelTokenRefresh: (...args: unknown[]) => mockCancelTokenRefresh(...args),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args)
}))

import {
  registerSyncHandlers,
  unregisterSyncHandlers,
  checkSyncIntegrity
} from './sync-core-handlers'

// ============================================================================
// Constants — channels registered by registerSyncHandlers (includes composed sub-modules)
// ============================================================================

const SYNC_CORE_CHANNELS = [
  // From sync-core-handlers.ts directly
  SYNC_CHANNELS.GET_STATUS,
  SYNC_CHANNELS.TRIGGER_SYNC,
  SYNC_CHANNELS.GET_HISTORY,
  SYNC_CHANNELS.GET_QUEUE_SIZE,
  SYNC_CHANNELS.PAUSE,
  SYNC_CHANNELS.RESUME,
  SYNC_CHANNELS.UPDATE_SYNCED_SETTING,
  SYNC_CHANNELS.GET_SYNCED_SETTINGS,
  SYNC_CHANNELS.GET_STORAGE_BREAKDOWN,
  SYNC_CHANNELS.UPLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
  SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
  SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
  SYNC_CHANNELS.GET_QUARANTINED_ITEMS,
  SYNC_CHANNELS.CHECK_DEVICE_STATUS,
  SYNC_CHANNELS.EMERGENCY_WIPE,
  // From auth-oauth-handlers (composed)
  SYNC_CHANNELS.AUTH_INIT_OAUTH,
  SYNC_CHANNELS.AUTH_REFRESH_TOKEN,
  SYNC_CHANNELS.SETUP_FIRST_DEVICE,
  SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
  SYNC_CHANNELS.GET_RECOVERY_PHRASE,
  SYNC_CHANNELS.AUTH_LOGOUT,
  // From auth-device-handlers (composed)
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
] as const

// ============================================================================
// Tests
// ============================================================================

describe('sync IPC handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    mockStoreGet.mockReturnValue({})
    mockRetrieveToken.mockResolvedValue('mock-access-token')
    mockStoreToken.mockResolvedValue(undefined)
    mockGetValidAccessToken.mockResolvedValue('mock-access-token')
    mockRefreshAccessToken.mockResolvedValue(true)
  })

  afterEach(() => {
    unregisterSyncHandlers()
  })

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  it('registers handlers for all sync channels (core + composed sub-modules)', () => {
    registerSyncHandlers()

    for (const channel of SYNC_CORE_CHANNELS) {
      expect(mockIpcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('unregisters all sync handlers', () => {
    registerSyncHandlers()
    unregisterSyncHandlers()

    for (const channel of SYNC_CORE_CHANNELS) {
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
