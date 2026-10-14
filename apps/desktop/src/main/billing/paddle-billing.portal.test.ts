import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  postToServer: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('../sync/token-manager', () => ({ getValidAccessToken: mocks.getValidAccessToken }))
vi.mock('../sync/http-client', async () => {
  const { SyncServerError } = await import('@memry/sync-client/http-errors')
  return { getFromServer: vi.fn(), postToServer: mocks.postToServer, SyncServerError }
})
vi.mock('../sync/runtime', () => ({ startSyncRuntime: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: mocks.openExternal } }))
vi.mock('../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))

import { SyncServerError } from '@memry/sync-client/http-errors'
import { openBillingPortal } from './paddle-billing'

describe('openBillingPortal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getValidAccessToken.mockResolvedValue('token')
  })

  it('opens the portal URL from the server', async () => {
    mocks.postToServer.mockResolvedValue({ portalUrl: 'https://portal.example/x' })
    await expect(openBillingPortal()).resolves.toEqual({
      success: true,
      portalUrl: 'https://portal.example/x'
    })
    expect(mocks.openExternal).toHaveBeenCalledWith('https://portal.example/x')
  })

  it('reports a missing billing customer instead of throwing (#3189)', async () => {
    mocks.postToServer.mockRejectedValue(new SyncServerError('Server returned 409', 409))
    await expect(openBillingPortal()).resolves.toEqual({
      success: false,
      reason: 'no-billing-customer'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('returns a plain failure for other server errors (#3189)', async () => {
    mocks.postToServer.mockRejectedValue(new SyncServerError('Server returned 502', 502))
    await expect(openBillingPortal()).resolves.toEqual({ success: false })
  })
})
