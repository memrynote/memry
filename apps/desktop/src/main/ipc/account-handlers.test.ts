import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountChannels } from '@memry/contracts/ipc-channels'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'

const mocks = vi.hoisted(() => ({
  query: {
    from: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn()
  },
  db: {
    select: vi.fn()
  },
  storeGet: vi.fn(),
  teardownSession: vi.fn(),
  getValidAccessToken: vi.fn(),
  getFromServer: vi.fn(),
  postToServer: vi.fn(),
  shellOpenExternal: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcMain.removeHandler(channel)
    })
  },
  shell: {
    openExternal: (...args: unknown[]) => mocks.shellOpenExternal(...args)
  }
}))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.db,
  isDatabaseInitialized: vi.fn()
}))

vi.mock('../store', () => ({
  store: {
    get: (...args: unknown[]) => mocks.storeGet(...args)
  }
}))

vi.mock('../sync/session-teardown', () => ({
  teardownSession: (...args: unknown[]) => mocks.teardownSession(...args)
}))

vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mocks.getValidAccessToken(...args)
}))

vi.mock('../sync/http-client', () => ({
  getFromServer: (...args: unknown[]) => mocks.getFromServer(...args),
  postToServer: (...args: unknown[]) => mocks.postToServer(...args)
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: vi.fn().mockReturnValue(null)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.logger
}))

import { isDatabaseInitialized } from '../database/client'
import { registerAccountHandlers, unregisterAccountHandlers } from './account-handlers'

describe('account-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    mocks.query.from.mockReturnValue(mocks.query)
    mocks.query.orderBy.mockReturnValue(mocks.query)
    mocks.query.limit.mockReturnValue(mocks.query)
    mocks.query.get.mockReturnValue(null)
    mocks.db.select.mockReturnValue(mocks.query)
    mocks.storeGet.mockReturnValue({ email: 'kaan@example.com' })
    mocks.teardownSession.mockResolvedValue({ keychainFailures: [] })
    mocks.getValidAccessToken.mockResolvedValue('token-1')
    mocks.postToServer.mockResolvedValue({ checkoutToken: 'checkout-token-1' })
    mocks.getFromServer.mockResolvedValue({
      plan: 'free',
      status: 'inactive',
      limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
      usage: { storageUsed: 0 },
      expiresAt: null,
      canManageBilling: false
    })
    mocks.shellOpenExternal.mockResolvedValue('')
    vi.mocked(isDatabaseInitialized).mockReturnValue(false)
  })

  afterEach(() => {
    unregisterAccountHandlers()
  })

  it('registers, unregisters, and returns account info without a database', async () => {
    registerAccountHandlers()
    expect(mockIpcMain._getHandler(AccountChannels.invoke.GET_INFO)).toBeDefined()

    await expect(invokeHandler(AccountChannels.invoke.GET_INFO)).resolves.toEqual({
      email: 'kaan@example.com',
      joinedAt: null
    })

    unregisterAccountHandlers()
    expect(mockIpcMain._getHandler(AccountChannels.invoke.GET_INFO)).toBeUndefined()
  })

  it('returns the first linked device timestamp when the database is initialized', async () => {
    vi.mocked(isDatabaseInitialized).mockReturnValue(true)
    mocks.query.get.mockReturnValue({ linkedAt: new Date('2026-05-01T10:00:00.000Z') })
    registerAccountHandlers()

    await expect(invokeHandler(AccountChannels.invoke.GET_INFO)).resolves.toEqual({
      email: 'kaan@example.com',
      joinedAt: Date.parse('2026-05-01T10:00:00.000Z')
    })
    expect(mocks.db.select).toHaveBeenCalled()
  })

  it('signs out and reports keychain cleanup warnings', async () => {
    mocks.teardownSession.mockResolvedValue({ keychainFailures: ['masterKey', 'deviceKey'] })
    registerAccountHandlers()

    await expect(invokeHandler(AccountChannels.invoke.SIGN_OUT)).resolves.toEqual({
      success: true,
      keychainWarning: 'Failed to remove: masterKey, deviceKey'
    })
    expect(mocks.teardownSession).toHaveBeenCalledWith('logout')
  })

  it('starts checkout by minting a token and opening checkout with a fragment', async () => {
    registerAccountHandlers()

    await expect(invokeHandler(AccountChannels.invoke.START_CHECKOUT)).resolves.toEqual({
      success: true,
      checkoutUrl: 'https://memrynote.com/account/sync#token=checkout-token-1'
    })

    expect(mocks.postToServer).toHaveBeenCalledWith('/auth/checkout-token', {}, 'token-1')
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(
      'https://memrynote.com/account/sync#token=checkout-token-1'
    )
  })

  it('rejects checkout start without an authenticated sync account', async () => {
    mocks.getValidAccessToken.mockResolvedValueOnce(null)
    registerAccountHandlers()

    await expect(invokeHandler(AccountChannels.invoke.START_CHECKOUT)).resolves.toEqual({
      success: false,
      error: 'Sign in to start checkout'
    })

    expect(mocks.shellOpenExternal).not.toHaveBeenCalled()
  })

  it('opens a fresh Paddle portal URL from the sync server', async () => {
    mocks.postToServer.mockResolvedValueOnce({
      portalUrl: 'https://customer-portal.paddle.com/cpl_1?action=overview&token=tmp'
    })
    registerAccountHandlers()

    await expect(invokeHandler(AccountChannels.invoke.OPEN_BILLING_PORTAL)).resolves.toEqual({
      success: true,
      portalUrl: 'https://customer-portal.paddle.com/cpl_1?action=overview&token=tmp'
    })

    expect(mocks.postToServer).toHaveBeenCalledWith('/auth/billing/portal-session', {}, 'token-1')
    expect(mocks.shellOpenExternal).toHaveBeenCalledWith(
      'https://customer-portal.paddle.com/cpl_1?action=overview&token=tmp'
    )
  })
})
