import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  stopSyncRuntime: vi.fn(),
  resetTokenManagerState: vi.fn(),
  getValidAccessToken: vi.fn(),
  clearPendingSession: vi.fn(),
  clearPendingLinkCompletion: vi.fn(),
  clearInMemoryAuthState: vi.fn(),
  wipeStorage: vi.fn(),
  resetCrdtProvider: vi.fn(),
  isDatabaseInitialized: vi.fn(),
  getDatabase: vi.fn(),
  storeSet: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
  listGoogleAccountIds: vi.fn(),
  stopGoogleCalendarSyncRunner: vi.fn(),
  postToServer: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  deleteRun: vi.fn(),
  deleteWhere: vi.fn(),
  dbDelete: vi.fn(),
  transaction: vi.fn()
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right }))
}))

vi.mock('../crypto', () => ({
  deleteKey: (...args: unknown[]) => mocks.deleteKey(...args)
}))

vi.mock('./runtime', () => ({
  stopSyncRuntime: (...args: unknown[]) => mocks.stopSyncRuntime(...args)
}))

vi.mock('./token-manager', () => ({
  resetTokenManagerState: (...args: unknown[]) => mocks.resetTokenManagerState(...args),
  getValidAccessToken: (...args: unknown[]) => mocks.getValidAccessToken(...args)
}))

vi.mock('./linking-service', () => ({
  clearPendingSession: (...args: unknown[]) => mocks.clearPendingSession(...args),
  clearPendingLinkCompletion: (...args: unknown[]) => mocks.clearPendingLinkCompletion(...args)
}))

vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ wipeStorage: mocks.wipeStorage }),
  resetCrdtProvider: (...args: unknown[]) => mocks.resetCrdtProvider(...args)
}))

vi.mock('../ipc/sync-core-handlers', () => ({
  clearInMemoryAuthState: (...args: unknown[]) => mocks.clearInMemoryAuthState(...args)
}))

vi.mock('../database/client', () => ({
  isDatabaseInitialized: (...args: unknown[]) => mocks.isDatabaseInitialized(...args),
  getDatabase: (...args: unknown[]) => mocks.getDatabase(...args)
}))

vi.mock('../store', () => ({
  store: {
    set: (...args: unknown[]) => mocks.storeSet(...args)
  }
}))

vi.mock('../calendar/providers/google/oauth', () => ({
  disconnectGoogleCalendar: (...args: unknown[]) => mocks.disconnectGoogleCalendar(...args),
  listGoogleAccountIds: (...args: unknown[]) => mocks.listGoogleAccountIds(...args)
}))

vi.mock('../calendar/providers/google/sync-service', () => ({
  stopGoogleCalendarSyncRunner: (...args: unknown[]) => mocks.stopGoogleCalendarSyncRunner(...args)
}))

vi.mock('./http-client', () => ({
  postToServer: (...args: unknown[]) => mocks.postToServer(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mocks.logInfo(...args),
    warn: (...args: unknown[]) => mocks.logWarn(...args),
    error: (...args: unknown[]) => mocks.logError(...args)
  })
}))

function setupDb() {
  const deleteBuilder = {
    where: mocks.deleteWhere,
    run: mocks.deleteRun
  }
  mocks.deleteWhere.mockReturnValue({ run: mocks.deleteRun })
  mocks.dbDelete.mockReturnValue(deleteBuilder)
  const tx = { delete: mocks.dbDelete }
  const db = {
    delete: mocks.dbDelete,
    transaction: mocks.transaction.mockImplementation((fn: (txArg: typeof tx) => void) => fn(tx))
  }
  mocks.getDatabase.mockReturnValue(db)
  return db
}

async function importModule() {
  return import('./session-teardown')
}

describe('session teardown', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setupDb()
    mocks.stopSyncRuntime.mockResolvedValue(undefined)
    mocks.getValidAccessToken.mockResolvedValue('access-token')
    mocks.postToServer.mockResolvedValue({})
    mocks.isDatabaseInitialized.mockReturnValue(true)
    mocks.listGoogleAccountIds.mockReturnValue(['calendar-a', 'calendar-b'])
    mocks.disconnectGoogleCalendar.mockResolvedValue(undefined)
    mocks.deleteKey.mockResolvedValue(undefined)
    mocks.wipeStorage.mockResolvedValue(undefined)
  })

  it('logs out by revoking the server session, clearing keychain state, and wiping local sync state', async () => {
    mocks.disconnectGoogleCalendar.mockRejectedValueOnce(new Error('calendar offline'))
    mocks.deleteKey.mockImplementation(async (entry: { account: string }) => {
      if (entry.account.includes('refresh')) throw new Error('keychain locked')
    })
    const { teardownSession } = await importModule()

    const result = await teardownSession('logout')

    expect(result.success).toBe(true)
    expect(result.keychainFailures).toEqual(
      expect.arrayContaining([expect.stringMatching(/refresh/)])
    )
    expect(mocks.stopSyncRuntime).toHaveBeenCalledWith({ skipFinalSync: true })
    expect(mocks.postToServer).toHaveBeenCalledWith('/auth/logout', {}, 'access-token')
    expect(mocks.disconnectGoogleCalendar).toHaveBeenCalledTimes(2)
    expect(mocks.clearInMemoryAuthState).toHaveBeenCalled()
    expect(mocks.clearPendingSession).toHaveBeenCalled()
    expect(mocks.clearPendingLinkCompletion).toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalled()
    expect(mocks.storeSet).toHaveBeenCalledWith('sync', {})
    expect(mocks.wipeStorage).toHaveBeenCalled()
    expect(mocks.resetCrdtProvider).toHaveBeenCalled()
  })

  it('handles integrity teardown without revoking the server session or wiping CRDT storage', async () => {
    const { teardownSession } = await importModule()

    await teardownSession('integrity')

    expect(mocks.stopSyncRuntime).toHaveBeenCalledWith({ skipFinalSync: true })
    expect(mocks.postToServer).not.toHaveBeenCalled()
    expect(mocks.disconnectGoogleCalendar).not.toHaveBeenCalled()
    expect(mocks.dbDelete).toHaveBeenCalled()
    expect(mocks.deleteWhere).toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.wipeStorage).not.toHaveBeenCalled()
  })

  it('reuses an in-flight teardown promise', async () => {
    let resolveStop: (() => void) | undefined
    mocks.stopSyncRuntime.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStop = resolve
      })
    )
    const { teardownSession } = await importModule()

    const first = teardownSession('shutdown')
    const second = teardownSession('shutdown')
    resolveStop?.()

    await expect(first).resolves.toEqual({ success: true, keychainFailures: [] })
    await expect(second).resolves.toEqual({ success: true, keychainFailures: [] })
    expect(mocks.stopSyncRuntime).toHaveBeenCalledTimes(1)
  })
})
