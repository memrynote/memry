import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  stopSyncRuntime: vi.fn(),
  resetTokenManagerState: vi.fn(),
  getValidAccessToken: vi.fn(),
  clearPendingSession: vi.fn(),
  clearPendingLinkCompletion: vi.fn(),
  clearInMemoryAuthState: vi.fn(),
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

// stopSyncRuntime() destroys the CRDT provider and drops the singleton, so the
// reopen at the end of teardown has to land on the *replacement* instance. A
// bare vi.fn() cannot tell the two apart — a reopen aimed at the provider that
// was already destroyed records an identical call, which is exactly how #1456's
// rebind passed its tests while failing 100% of the time in production. So the
// fake mints a new instance on every reset and records which one each
// initPersistence() call actually reached.
const crdtProvider = vi.hoisted(() => {
  const initPersistence = vi.fn()
  // Not a method the provider has any more — kept on the fake so a re-added
  // sign-out wipe fails here loudly instead of silently deleting history.
  const wipeStorage = vi.fn()
  let generation = 0
  const openedGenerations: number[] = []

  return {
    initPersistence,
    wipeStorage,
    openedGenerations,
    liveGeneration: () => generation,
    /** What stopSyncRuntime() does to the provider: destroy it, drop the singleton. */
    destroyAndReset: () => {
      generation += 1
    },
    reset: () => {
      generation = 0
      openedGenerations.length = 0
    },
    get: () => {
      const instance = generation
      return {
        initPersistence: (...args: unknown[]) => {
          openedGenerations.push(instance)
          return initPersistence(...args)
        },
        wipeStorage: (...args: unknown[]) => wipeStorage(...args)
      }
    }
  }
})

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
  getCrdtProvider: () => crdtProvider.get()
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

vi.mock('../calendar/google/oauth', () => ({
  disconnectGoogleCalendar: (...args: unknown[]) => mocks.disconnectGoogleCalendar(...args),
  listGoogleAccountIds: (...args: unknown[]) => mocks.listGoogleAccountIds(...args)
}))

vi.mock('../calendar/google/sync-service', () => ({
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

/** The store came back up, on the instance that replaced the destroyed one. */
function expectStoreReopened() {
  expect(crdtProvider.initPersistence).toHaveBeenCalledTimes(1)
  expect(crdtProvider.openedGenerations).toEqual([crdtProvider.liveGeneration()])
}

function expectStoreLeftClosed() {
  expect(crdtProvider.initPersistence).not.toHaveBeenCalled()
}

describe('session teardown', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setupDb()
    crdtProvider.reset()
    mocks.stopSyncRuntime.mockImplementation(async () => {
      crdtProvider.destroyAndReset()
    })
    mocks.getValidAccessToken.mockResolvedValue('access-token')
    mocks.postToServer.mockResolvedValue({})
    mocks.isDatabaseInitialized.mockReturnValue(true)
    mocks.listGoogleAccountIds.mockReturnValue(['calendar-a', 'calendar-b'])
    mocks.disconnectGoogleCalendar.mockResolvedValue(undefined)
    mocks.deleteKey.mockResolvedValue(undefined)
    crdtProvider.initPersistence.mockResolvedValue(undefined)
    crdtProvider.wipeStorage.mockResolvedValue(undefined)
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
    expect(crdtProvider.wipeStorage).not.toHaveBeenCalled()
  })

  // Which reasons put the CRDT store back, and which must not. stopSyncRuntime()
  // destroys and resets the provider on the way in, so anything that leaves the
  // app running has to reopen it or the editor stays unbound to any Y.Doc until
  // the next launch. Editing is never gated on session state.
  describe('CRDT store reopen', () => {
    // The store used to be deleted here. It held the only local record of how
    // each note got to its current state, so a note edited while signed out had
    // nothing to merge against on sign-in: the other device's version replaced
    // it outright.
    it('reopens the store on sign-out, and never wipes it', async () => {
      const { teardownSession } = await importModule()

      await teardownSession('logout')

      expect(crdtProvider.wipeStorage).not.toHaveBeenCalled()
      expectStoreReopened()
    })

    // An integrity teardown is an involuntary sign-out, triggered by one
    // keychain read that may itself be wrong. The user did not ask for it and
    // is not told the editor went read-only, so leaving the provider dead here
    // is worse than leaving it dead on an explicit sign-out.
    it('reopens the store after an integrity teardown', async () => {
      const { teardownSession } = await importModule()

      await teardownSession('integrity')

      expect(crdtProvider.wipeStorage).not.toHaveBeenCalled()
      expectStoreReopened()
    })

    // The one reason that must not. The app is quitting: there is no editor
    // left to serve, the vault uuid the store is scoped to is read from a data
    // DB closeVault() is about to close, and a reopen would leave a freshly
    // opened LevelDB store behind on the way out.
    it('leaves the store closed on shutdown', async () => {
      const { teardownSession } = await importModule()

      await teardownSession('shutdown')

      expectStoreLeftClosed()
    })
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
