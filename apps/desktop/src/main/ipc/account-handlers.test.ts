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
  retrieveKey: vi.fn(),
  getValidAccessToken: vi.fn(),
  toBase64: vi.fn(),
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

vi.mock('../crypto', () => ({
  retrieveKey: (...args: unknown[]) => mocks.retrieveKey(...args)
}))

vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: (...args: unknown[]) => mocks.getValidAccessToken(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    to_base64: (...args: unknown[]) => mocks.toBase64(...args),
    base64_variants: { URLSAFE_NO_PADDING: 7 }
  }
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
    mocks.retrieveKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    mocks.toBase64.mockReturnValue('recovery-key')
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

  it('returns recovery key authentication, missing-key, success, and failure states', async () => {
    registerAccountHandlers()

    mocks.getValidAccessToken.mockResolvedValueOnce(null)
    await expect(invokeHandler(AccountChannels.invoke.GET_RECOVERY_KEY)).resolves.toEqual({
      success: false,
      error: 'Not authenticated'
    })

    mocks.retrieveKey.mockResolvedValueOnce(null)
    await expect(invokeHandler(AccountChannels.invoke.GET_RECOVERY_KEY)).resolves.toEqual({
      success: false,
      error: 'Recovery key not available on this device'
    })

    await expect(invokeHandler(AccountChannels.invoke.GET_RECOVERY_KEY)).resolves.toEqual({
      success: true,
      key: 'recovery-key'
    })
    expect(mocks.toBase64).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 7)

    mocks.retrieveKey.mockRejectedValueOnce(new Error('keychain failed'))
    await expect(invokeHandler(AccountChannels.invoke.GET_RECOVERY_KEY)).resolves.toEqual({
      success: false,
      error: 'Failed to retrieve recovery key'
    })
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to retrieve recovery key',
      expect.any(Error)
    )
  })
})
