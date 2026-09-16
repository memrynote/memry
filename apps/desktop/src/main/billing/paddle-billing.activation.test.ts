import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  getFromServer: vi.fn(),
  postToServer: vi.fn(),
  getSyncEngine: vi.fn(),
  startSyncRuntime: vi.fn(),
  setCachedEntitlementFromStatus: vi.fn((s: { plan: string; status: string }) => ({
    isPaid: s.plan !== 'free' && s.status === 'active',
    plan: s.plan,
    status: s.status
  })),
  getCachedEntitlement: vi.fn(() => null),
  isPaidBillingStatus: vi.fn(
    (s: { plan: string; status: string }) => s.plan !== 'free' && s.status === 'active'
  ),
  // Same rule as the real helper: an unpaid verdict is only trusted while it is
  // younger than the TTL, and one with no timestamp has an unknowable age.
  isCachedUnpaidFresh: vi.fn((cached: { isPaid: boolean; cachedAt?: number } | null) => {
    if (!cached || cached.isPaid || typeof cached.cachedAt !== 'number') return false
    const age = Date.now() - cached.cachedAt
    return age >= 0 && age <= 60 * 60 * 1000
  })
}))

vi.mock('../sync/token-manager', () => ({ getValidAccessToken: mocks.getValidAccessToken }))
vi.mock('../sync/http-client', () => ({
  getFromServer: mocks.getFromServer,
  postToServer: mocks.postToServer
}))
vi.mock('../sync/runtime', () => ({
  getSyncEngine: mocks.getSyncEngine,
  startSyncRuntime: mocks.startSyncRuntime
}))
vi.mock('./entitlement-cache', () => ({
  setCachedEntitlementFromStatus: mocks.setCachedEntitlementFromStatus,
  getCachedEntitlement: mocks.getCachedEntitlement,
  isPaidBillingStatus: mocks.isPaidBillingStatus,
  isCachedUnpaidFresh: mocks.isCachedUnpaidFresh
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))

import { resolveEntitlementForSyncStart, reconcileBillingAndSync } from './paddle-billing'

const paidStatus = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  email: null,
  limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
  usage: { storageUsed: 0 },
  expiresAt: null,
  canManageBilling: true
}

describe('paddle-billing activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getValidAccessToken.mockResolvedValue('access-token')
  })

  it('resolveEntitlementForSyncStart returns a RECENT cached unpaid WITHOUT a server call', async () => {
    mocks.getCachedEntitlement.mockReturnValue({
      isPaid: false,
      plan: 'free',
      status: 'inactive',
      cachedAt: Date.now() - 60_000
    })
    const result = await resolveEntitlementForSyncStart()
    expect(result.isPaid).toBe(false)
    expect(mocks.getFromServer).not.toHaveBeenCalled()
  })

  // The upgrade path that used to dead-end: bought on the web or on another
  // device, nothing rewrites this cache, and an eternal negative kept a paying
  // user in local-only forever.
  it('re-asks the server when the cached unpaid verdict is stale, and sees the upgrade', async () => {
    mocks.getCachedEntitlement.mockReturnValue({
      isPaid: false,
      plan: 'free',
      status: 'inactive',
      cachedAt: Date.now() - 25 * 60 * 60 * 1000
    })
    mocks.getFromServer.mockResolvedValue(paidStatus)

    const result = await resolveEntitlementForSyncStart()

    expect(mocks.getFromServer).toHaveBeenCalledWith('/auth/billing', 'access-token')
    expect(result.isPaid).toBe(true)
  })

  it('re-asks the server for a cache written before cachedAt existed', async () => {
    mocks.getCachedEntitlement.mockReturnValue({ isPaid: false, plan: 'free', status: 'inactive' })
    mocks.getFromServer.mockResolvedValue(paidStatus)

    const result = await resolveEntitlementForSyncStart()

    expect(mocks.getFromServer).toHaveBeenCalledTimes(1)
    expect(result.isPaid).toBe(true)
  })

  it('resolveEntitlementForSyncStart fetches + caches when cache is unknown', async () => {
    mocks.getCachedEntitlement.mockReturnValue(null)
    mocks.getFromServer.mockResolvedValue(paidStatus)
    const result = await resolveEntitlementForSyncStart()
    expect(mocks.getFromServer).toHaveBeenCalledWith('/auth/billing', 'access-token')
    expect(mocks.setCachedEntitlementFromStatus).toHaveBeenCalledWith(paidStatus)
    expect(result.isPaid).toBe(true)
  })

  it('reconcileBillingAndSync caches + starts the runtime when active', async () => {
    mocks.postToServer.mockResolvedValue(paidStatus)
    await reconcileBillingAndSync({ transactionId: 'txn_1' })
    expect(mocks.setCachedEntitlementFromStatus).toHaveBeenCalledWith(paidStatus)
    expect(mocks.startSyncRuntime).toHaveBeenCalledTimes(1)
  })
})
