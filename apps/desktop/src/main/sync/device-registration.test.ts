import { beforeEach, describe, expect, it, vi } from 'vitest'

const keychainEntries = {
  ACCESS_TOKEN: { account: 'access-token' },
  REFRESH_TOKEN: { account: 'refresh-token' },
  SETUP_TOKEN: { account: 'setup-token' },
  MASTER_KEY: { account: 'master-key' },
  DEVICE_SIGNING_KEY: { account: 'device-signing-key' }
}

const mocks = vi.hoisted(() => ({
  storeKey: vi.fn(),
  deleteKey: vi.fn(),
  getDevicePublicKey: vi.fn(),
  postToServer: vi.fn(),
  deleteFromServer: vi.fn(),
  retrieveToken: vi.fn(),
  storeToken: vi.fn(),
  scheduleTokenRefresh: vi.fn(),
  extractJtiFromToken: vi.fn(),
  getDatabase: vi.fn(),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1'),
  getSyncEngine: vi.fn(),
  startSyncRuntime: vi.fn(),
  startGoogleCalendarSyncRunner: vi.fn(),
  activate: vi.fn(),
  parseDeviceResponse: vi.fn(),
  logError: vi.fn(),
  toBase64: vi.fn(),
  sign: vi.fn(),
  bindLocalVaultToMasterKey: vi.fn(),
  dbDelete: vi.fn(),
  dbWhere: vi.fn(),
  dbRun: vi.fn(),
  dbInsert: vi.fn(),
  dbValues: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0'
  }
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    ready: Promise.resolve(),
    base64_variants: { ORIGINAL: 'original' },
    to_base64: (...args: unknown[]) => mocks.toBase64(...args),
    crypto_sign_detached: (...args: unknown[]) => mocks.sign(...args)
  }
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  inArray: vi.fn((left, values) => ({ left, values }))
}))

vi.mock('@memry/contracts/crypto', () => ({
  KEYCHAIN_ENTRIES: keychainEntries
}))

vi.mock('@memry/contracts/auth-api', () => ({
  DeviceRegisterResponseSchema: {
    parse: (...args: unknown[]) => mocks.parseDeviceResponse(...args)
  }
}))

vi.mock('../crypto', () => ({
  storeKey: (...args: unknown[]) => mocks.storeKey(...args),
  deleteKey: (...args: unknown[]) => mocks.deleteKey(...args),
  getDevicePublicKey: (...args: unknown[]) => mocks.getDevicePublicKey(...args),
  bindLocalVaultToMasterKey: (...args: unknown[]) => mocks.bindLocalVaultToMasterKey(...args)
}))

vi.mock('../database/client', () => ({
  getDatabase: (...args: unknown[]) => mocks.getDatabase(...args)
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: (...args: unknown[]) => mocks.getOrCreateVaultUuid(...args)
}))

vi.mock('./http-client', () => ({
  postToServer: (...args: unknown[]) => mocks.postToServer(...args),
  deleteFromServer: (...args: unknown[]) => mocks.deleteFromServer(...args)
}))

vi.mock('./runtime', () => ({
  getSyncEngine: (...args: unknown[]) => mocks.getSyncEngine(...args),
  startSyncRuntime: (...args: unknown[]) => mocks.startSyncRuntime(...args)
}))

vi.mock('../calendar/google/sync-service', () => ({
  startGoogleCalendarSyncRunner: (...args: unknown[]) =>
    mocks.startGoogleCalendarSyncRunner(...args)
}))

vi.mock('./token-manager', () => ({
  ACCESS_TOKEN_EXPIRY_SECONDS: 3600,
  extractJtiFromToken: (...args: unknown[]) => mocks.extractJtiFromToken(...args),
  retrieveToken: (...args: unknown[]) => mocks.retrieveToken(...args),
  scheduleTokenRefresh: (...args: unknown[]) => mocks.scheduleTokenRefresh(...args),
  storeToken: (...args: unknown[]) => mocks.storeToken(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mocks.logError(...args) })
}))

function setupDb() {
  mocks.dbWhere.mockReturnValue({ run: mocks.dbRun })
  mocks.dbDelete.mockReturnValue({ where: mocks.dbWhere, run: mocks.dbRun })
  mocks.dbValues.mockReturnValue({ run: mocks.dbRun })
  mocks.dbInsert.mockReturnValue({ values: mocks.dbValues })
  const tx = {
    delete: mocks.dbDelete,
    insert: mocks.dbInsert
  }
  const db = {
    transaction: vi.fn((fn: (txArg: typeof tx) => void) => fn(tx))
  }
  mocks.getDatabase.mockReturnValue(db)
  return db
}

async function importModule() {
  return import('./device-registration')
}

describe('device registration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setupDb()
    mocks.getDevicePublicKey.mockReturnValue(new Uint8Array([1, 2, 3]))
    mocks.toBase64.mockImplementation((bytes: Uint8Array) => `b64-${Array.from(bytes).join('-')}`)
    mocks.sign.mockReturnValue(new Uint8Array([9, 8, 7]))
    mocks.extractJtiFromToken.mockReturnValue('setup-jti')
    mocks.parseDeviceResponse.mockImplementation((value) => value)
    mocks.postToServer.mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      deviceId: 'device-1'
    })
    mocks.retrieveToken.mockResolvedValue('access')
    mocks.getSyncEngine.mockReturnValue({ activate: mocks.activate })
    mocks.startGoogleCalendarSyncRunner.mockResolvedValue(undefined)
    mocks.storeKey.mockResolvedValue(undefined)
    mocks.storeToken.mockResolvedValue(undefined)
    mocks.deleteKey.mockResolvedValue(undefined)
    mocks.deleteFromServer.mockResolvedValue({})
    mocks.bindLocalVaultToMasterKey.mockResolvedValue(undefined)
  })

  it('registers a device, stores tokens and keys, seeds the local device row, and activates sync', async () => {
    const { persistKeysAndRegisterDevice } = await importModule()

    await expect(
      persistKeysAndRegisterDevice(
        new Uint8Array([5]),
        new Uint8Array([6]),
        'setup-token',
        'salt',
        'verifier'
      )
    ).resolves.toBe('device-1')

    expect(mocks.storeKey).toHaveBeenCalledWith(
      keychainEntries.DEVICE_SIGNING_KEY,
      new Uint8Array([6])
    )
    expect(mocks.postToServer).toHaveBeenCalledWith(
      '/auth/devices',
      expect.objectContaining({
        authPublicKey: 'b64-1-2-3',
        challengeSignature: 'b64-9-8-7',
        challengeNonce: expect.any(String)
      }),
      'setup-token'
    )
    expect(mocks.storeToken).toHaveBeenCalledWith(keychainEntries.ACCESS_TOKEN, 'access')
    expect(mocks.storeToken).toHaveBeenCalledWith(keychainEntries.REFRESH_TOKEN, 'refresh')
    expect(mocks.scheduleTokenRefresh).toHaveBeenCalledWith(3600)
    expect(mocks.postToServer).toHaveBeenCalledWith(
      '/auth/setup',
      { kdfSalt: 'salt', keyVerifier: 'verifier' },
      'access'
    )
    expect(mocks.storeKey).toHaveBeenCalledWith(keychainEntries.MASTER_KEY, new Uint8Array([5]))
    expect(mocks.bindLocalVaultToMasterKey).toHaveBeenCalledWith(
      mocks.getDatabase.mock.results[0].value,
      'vault-1',
      new Uint8Array([5])
    )
    expect(mocks.dbInsert).toHaveBeenCalled()
    expect(mocks.activate).toHaveBeenCalled()
    expect(mocks.startGoogleCalendarSyncRunner).toHaveBeenCalled()
  })

  it('removes the signing key when server registration fails', async () => {
    mocks.postToServer.mockRejectedValueOnce(new Error('server down'))
    const { persistKeysAndRegisterDevice } = await importModule()

    await expect(
      persistKeysAndRegisterDevice(
        new Uint8Array([5]),
        new Uint8Array([6]),
        'setup-token',
        'salt',
        'verifier'
      )
    ).rejects.toThrow('server down')

    expect(mocks.deleteKey).toHaveBeenCalledWith(keychainEntries.DEVICE_SIGNING_KEY)
    expect(mocks.storeKey).not.toHaveBeenCalledWith(keychainEntries.MASTER_KEY, expect.anything())
  })

  it('deregisters the device and clears tokens when master-key storage fails', async () => {
    mocks.storeKey.mockImplementation(async (entry: { account: string }) => {
      if (entry.account === 'master-key') throw new Error('keychain locked')
    })
    const { persistKeysAndRegisterDevice } = await importModule()

    await expect(
      persistKeysAndRegisterDevice(
        new Uint8Array([5]),
        new Uint8Array([6]),
        'setup-token',
        'salt',
        'verifier',
        true,
        true
      )
    ).rejects.toThrow('Failed to save encryption key securely')

    expect(mocks.deleteFromServer).toHaveBeenCalledWith('/auth/devices/device-1', 'access')
    expect(mocks.deleteKey).toHaveBeenCalledWith(keychainEntries.ACCESS_TOKEN)
    expect(mocks.deleteKey).toHaveBeenCalledWith(keychainEntries.REFRESH_TOKEN)
    expect(mocks.deleteKey).toHaveBeenCalledWith(keychainEntries.DEVICE_SIGNING_KEY)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.startSyncRuntime).not.toHaveBeenCalled()
  })
})
