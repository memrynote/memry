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

const mockGetSettingsSyncManager = vi.fn().mockReturnValue(null)
vi.mock('../sync/settings-sync', () => ({
  getSettingsSyncManager: () => mockGetSettingsSyncManager()
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: vi.fn().mockReturnValue(null),
  startSyncRuntime: vi.fn().mockResolvedValue(null),
  getNetworkMonitor: vi.fn().mockReturnValue(null)
}))

const mockGetCachedEntitlement = vi.fn().mockReturnValue(null)
vi.mock('../billing/entitlement-cache', () => ({
  getCachedEntitlement: () => mockGetCachedEntitlement()
}))

const mockTeardownSession = vi.fn().mockResolvedValue({ success: true, keychainFailures: [] })
vi.mock('../sync/session-teardown', () => ({
  teardownSession: (...args: unknown[]) => mockTeardownSession(...args)
}))

const mockCheckLocalKeyAgainstAccount = vi.fn()
const mockIsKeyMaterialActivityRecent = vi.fn()
vi.mock('../sync/key-verification', () => ({
  checkLocalKeyAgainstAccount: (...args: unknown[]) => mockCheckLocalKeyAgainstAccount(...args),
  isKeyMaterialActivityRecent: (...args: unknown[]) => mockIsKeyMaterialActivityRecent(...args)
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

import * as syncRuntime from '../sync/runtime'
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
    mockGetSettingsSyncManager.mockReturnValue(null)
    mockIsDatabaseInitialized.mockReturnValue(true)
    mockSelectGet.mockReturnValue(undefined)
    mockRetrieveKey.mockReset()
    mockTeardownSession.mockResolvedValue({ success: true, keychainFailures: [] })
    mockCheckLocalKeyAgainstAccount.mockResolvedValue('match')
    mockIsKeyMaterialActivityRecent.mockReturnValue(false)
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
      error: 'errors:sync.engineNotInitialized'
    })
  })

  it('TRIGGER_SYNC starts the runtime when no engine is running', async () => {
    const startedEngine = { fullSync: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(syncRuntime.startSyncRuntime).mockResolvedValueOnce(startedEngine as never)

    registerSyncHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)

    expect(syncRuntime.startSyncRuntime).toHaveBeenCalledTimes(1)
    expect(startedEngine.fullSync).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
  })

  it('GET_STATUS returns local_only when no engine and cached entitlement is unpaid', async () => {
    mockGetCachedEntitlement.mockReturnValueOnce({
      isPaid: false,
      plan: 'free',
      status: 'inactive'
    })

    registerSyncHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.GET_STATUS)

    expect(result).toEqual({ status: 'local_only', pendingCount: 0 })
  })

  it('delegates core status, sync, queue, pause, resume, quarantine, device, and wipe handlers', async () => {
    const engine = {
      getStatus: vi.fn(() => ({ status: 'syncing', pendingCount: 2 })),
      fullSync: vi.fn(async () => undefined),
      getQueueStats: vi.fn(() => ({ pending: 3, failed: 1 })),
      pause: vi.fn(() => ({ success: true, wasPaused: false })),
      resume: vi.fn(() => ({ success: true, pendingCount: 3 })),
      getQuarantinedItems: vi.fn(() => [{ id: 'bad-item' }]),
      checkDeviceStatus: vi.fn(async () => 'active'),
      performEmergencyWipe: vi.fn(async () => undefined)
    }
    registerSyncHandlers(engine as never)

    await expect(invokeHandler(SYNC_CHANNELS.GET_STATUS)).resolves.toEqual({
      status: 'syncing',
      pendingCount: 2
    })
    await expect(invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)).resolves.toEqual({ success: true })
    expect(engine.fullSync).toHaveBeenCalledTimes(1)
    await expect(invokeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)).resolves.toEqual({
      pending: 3,
      failed: 1
    })
    await expect(invokeHandler(SYNC_CHANNELS.PAUSE)).resolves.toEqual({
      success: true,
      wasPaused: false
    })
    await expect(invokeHandler(SYNC_CHANNELS.RESUME)).resolves.toEqual({
      success: true,
      pendingCount: 3
    })
    await expect(invokeHandler(SYNC_CHANNELS.GET_QUARANTINED_ITEMS)).resolves.toEqual([
      { id: 'bad-item' }
    ])
    await expect(invokeHandler(SYNC_CHANNELS.CHECK_DEVICE_STATUS)).resolves.toEqual({
      status: 'active'
    })
    await expect(invokeHandler(SYNC_CHANNELS.EMERGENCY_WIPE)).resolves.toEqual({
      success: true
    })
    expect(engine.performEmergencyWipe).toHaveBeenCalledTimes(1)
    expect(mockTeardownSession).toHaveBeenCalledWith('integrity')
  })

  it('returns fallback values for core handlers when no engine exists', async () => {
    registerSyncHandlers()

    await expect(invokeHandler(SYNC_CHANNELS.GET_STATUS)).resolves.toEqual({
      status: 'idle',
      pendingCount: 0
    })
    await expect(invokeHandler(SYNC_CHANNELS.GET_QUEUE_SIZE)).resolves.toEqual({
      pending: 0,
      failed: 0
    })
    await expect(invokeHandler(SYNC_CHANNELS.PAUSE)).resolves.toEqual({
      success: false,
      wasPaused: false
    })
    await expect(invokeHandler(SYNC_CHANNELS.RESUME)).resolves.toEqual({
      success: false,
      pendingCount: 0
    })
    await expect(invokeHandler(SYNC_CHANNELS.GET_QUARANTINED_ITEMS)).resolves.toEqual([])
    await expect(invokeHandler(SYNC_CHANNELS.CHECK_DEVICE_STATUS)).resolves.toEqual({
      status: 'unknown'
    })
    await expect(invokeHandler(SYNC_CHANNELS.EMERGENCY_WIPE)).resolves.toEqual({
      success: true
    })
  })

  it('returns the settings sync error key when settings sync is not initialized', async () => {
    registerSyncHandlers()

    const result = await invokeHandler(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, {
      fieldPath: 'general.locale',
      value: 'en'
    })

    expect(result).toEqual({
      success: false,
      error: 'errors:sync.settingsNotInitialized'
    })
  })

  it('updates and reads synced settings when the settings manager exists', async () => {
    const manager = {
      updateField: vi.fn(),
      getSettings: vi.fn(() => ({ general: { locale: 'en' } }))
    }
    mockGetSettingsSyncManager.mockReturnValue(manager)
    registerSyncHandlers()

    await expect(
      invokeHandler(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, {
        fieldPath: 'general.locale',
        value: 'tr'
      })
    ).resolves.toEqual({ success: true })
    expect(manager.updateField).toHaveBeenCalledWith('general.locale', 'tr', 'local')

    await expect(invokeHandler(SYNC_CHANNELS.GET_SYNCED_SETTINGS)).resolves.toEqual({
      general: { locale: 'en' }
    })
  })

  it('returns null synced settings and storage when dependencies are missing', async () => {
    registerSyncHandlers()
    mockGetValidAccessToken.mockResolvedValueOnce(null)

    await expect(invokeHandler(SYNC_CHANNELS.GET_SYNCED_SETTINGS)).resolves.toBeNull()
    await expect(invokeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)).resolves.toBeNull()
  })

  it('GET_STORAGE_BREAKDOWN makes no network call for a free user', async () => {
    // #given a free user — the server correctly answers 402, but production saw
    // 4x SYNC_PAYMENT_REQUIRED from one user because the call was ungated.
    // mockReturnValueOnce (not mockReturnValue) so an assertion failure below
    // cannot leak isPaid:false into the next test — clearAllMocks keeps
    // implementations, and the old reset sat AFTER the assertions.
    mockGetCachedEntitlement.mockReturnValueOnce({
      isPaid: false,
      plan: 'free',
      status: 'inactive'
    })
    registerSyncHandlers()

    // #when the renderer asks for the storage breakdown
    const result = await invokeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)

    // #then the round-trip never happens (same null the no-token path returns)
    expect(result).toBeNull()
    expect(mockGetFromServer).not.toHaveBeenCalled()
    expect(mockGetValidAccessToken).not.toHaveBeenCalled()
  })

  it('GET_STORAGE_BREAKDOWN still fetches when entitlement is unknown', async () => {
    // #given no cached entitlement yet (fresh install, pre-first-status)
    mockGetCachedEntitlement.mockReturnValue(null)
    registerSyncHandlers()
    mockGetFromServer.mockResolvedValueOnce({ usedBytes: 10, quotaBytes: 100 })

    // #then we do not gate on an unknown — mirrors the GET_STATUS precedent
    await expect(invokeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)).resolves.toEqual({
      usedBytes: 10,
      quotaBytes: 100
    })
  })

  it('fetches storage breakdown with a valid access token', async () => {
    registerSyncHandlers()
    mockGetFromServer.mockResolvedValueOnce({ usedBytes: 10, quotaBytes: 100 })

    await expect(invokeHandler(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)).resolves.toEqual({
      usedBytes: 10,
      quotaBytes: 100
    })
    expect(mockGetFromServer).toHaveBeenCalledWith('/sync/storage', 'mock-access-token')
  })

  it('returns paginated sync history and parses JSON details when available', async () => {
    registerSyncHandlers()
    const row = {
      id: 'history-1',
      type: 'pull',
      itemCount: 2,
      direction: null,
      details: '{"items":2}',
      durationMs: null,
      createdAt: new Date('2026-05-01T10:00:00.000Z')
    }
    const errorRow = {
      id: 'history-2',
      type: 'error',
      itemCount: 0,
      direction: 'down',
      details: 'plain failure',
      durationMs: 25,
      createdAt: new Date('2026-05-01T11:00:00.000Z')
    }
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([row, errorRow]) })
            })
          })
        })
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([{ total: 2 }])
        })
      })

    await expect(
      invokeHandler(SYNC_CHANNELS.GET_HISTORY, { limit: 10, offset: 5 })
    ).resolves.toEqual({
      entries: [
        {
          id: 'history-1',
          type: 'pull',
          itemCount: 2,
          direction: undefined,
          details: { items: 2 },
          durationMs: undefined,
          createdAt: new Date('2026-05-01T10:00:00.000Z').getTime()
        },
        {
          id: 'history-2',
          type: 'error',
          itemCount: 0,
          direction: 'down',
          details: 'plain failure',
          durationMs: 25,
          createdAt: new Date('2026-05-01T11:00:00.000Z').getTime()
        }
      ],
      total: 2
    })
  })

  it('returns empty sync history when no vault is open', async () => {
    registerSyncHandlers()
    mockIsDatabaseInitialized.mockReturnValueOnce(false)

    await expect(invokeHandler(SYNC_CHANNELS.GET_HISTORY, {})).resolves.toEqual({
      entries: [],
      total: 0
    })
  })

  it('returns the sync trigger error key when full sync fails without a concrete message', async () => {
    registerSyncHandlers({
      fullSync: vi.fn(async () => {
        throw null
      })
    } as never)

    const result = await invokeHandler(SYNC_CHANNELS.TRIGGER_SYNC)
    expect(result).toEqual({
      success: false,
      error: 'errors:sync.triggerFailed'
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

    it('cleans up local sync state when master or signing keys are missing', async () => {
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockRetrieveKey.mockResolvedValueOnce(null)

      await checkSyncIntegrity()
      expect(mockTeardownSession).toHaveBeenCalledWith('integrity')

      mockTeardownSession.mockClear()
      mockRetrieveKey.mockResolvedValueOnce(new Uint8Array(32).fill(1)).mockResolvedValueOnce(null)

      await checkSyncIntegrity()
      expect(mockTeardownSession).toHaveBeenCalledWith('integrity')
    })

    it('does NOT tear down local state when the master key read throws transiently', async () => {
      // Regression: a transient keychain read failure (safeStorage not ready,
      // a mid-flight keytar→safeStorage migration, an OS keychain lock) must
      // never be misread as "key absent" and trigger a destructive re-auth that
      // rebinds key material the vault no longer matches.
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockRetrieveKey.mockRejectedValueOnce(new Error('Failed to retrieve key from keychain'))

      await checkSyncIntegrity()

      expect(mockTeardownSession).not.toHaveBeenCalled()
    })

    it('does NOT tear down local state when the signing key read throws transiently', async () => {
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockRetrieveKey
        .mockResolvedValueOnce(new Uint8Array(32).fill(1))
        .mockRejectedValueOnce(new Error('Failed to retrieve key from keychain'))

      await checkSyncIntegrity()

      expect(mockTeardownSession).not.toHaveBeenCalled()
    })

    it('signs out an install whose master key no longer matches the account (auto-heal for the broken release)', async () => {
      // The broken 2026.717.x release left installs holding a master key that
      // can never decrypt the account's data. On startup the integrity check
      // confirms the mismatch against the account verifier, emits the recovery
      // prompt, and tears the session down so ordinary sign-in + recovery
      // phrase restores the correct key.
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockRetrieveKey
        .mockResolvedValueOnce(new Uint8Array(32).fill(1))
        .mockResolvedValueOnce(new Uint8Array(64).fill(9))
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(8))
      mockCheckLocalKeyAgainstAccount.mockResolvedValue('mismatch')
      const send = vi.fn()
      mockGetAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { send } }])

      await checkSyncIntegrity()

      expect(mockTeardownSession).toHaveBeenCalledWith('integrity')
      expect(send).toHaveBeenCalledWith('sync:vault-recovery-needed', {
        reason: 'vault-key-mismatch'
      })
    })

    it('does NOT sign out when the key matches, is unknown, or is mid-transition', async () => {
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(8))

      for (const verdict of ['match', 'unknown', 'transition'] as const) {
        mockTeardownSession.mockClear()
        mockRetrieveKey
          .mockResolvedValueOnce(new Uint8Array(32).fill(1))
          .mockResolvedValueOnce(new Uint8Array(64).fill(9))
        mockCheckLocalKeyAgainstAccount.mockResolvedValue(verdict)

        await checkSyncIntegrity()

        expect(mockTeardownSession).not.toHaveBeenCalled()
      }
    })

    it('does NOT sign out on a mismatch while key material is being re-established', async () => {
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      mockRetrieveKey
        .mockResolvedValueOnce(new Uint8Array(32).fill(1))
        .mockResolvedValueOnce(new Uint8Array(64).fill(9))
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(8))
      mockCheckLocalKeyAgainstAccount.mockResolvedValue('mismatch')
      mockIsKeyMaterialActivityRecent.mockReturnValue(true)

      await checkSyncIntegrity()

      expect(mockTeardownSession).not.toHaveBeenCalled()
    })

    it('leaves matching signing keys alone and swallows integrity errors', async () => {
      mockIsDatabaseInitialized.mockReturnValue(true)
      mockSelectGet.mockReturnValue({ id: 'dev-1', signingPublicKey: 'base64-encoded' })
      const fakeSigningKey = new Uint8Array(64).fill(9)
      mockRetrieveKey
        .mockResolvedValueOnce(new Uint8Array(32).fill(1))
        .mockResolvedValueOnce(fakeSigningKey)
      mockGetDevicePublicKey.mockReturnValue(new Uint8Array(32).fill(8))

      await checkSyncIntegrity()
      expect(mockSecureCleanup).toHaveBeenCalledWith(fakeSigningKey)
      expect(mockUpdateSet).not.toHaveBeenCalled()

      mockDb.select.mockImplementationOnce(() => {
        throw new Error('db unavailable')
      })
      await expect(checkSyncIntegrity()).resolves.toBeUndefined()
    })
  })
})
