import { describe, it, expect, beforeEach, vi } from 'vitest'

const storeData: { sync: Record<string, unknown> } = { sync: {} }
const storeGet = vi.fn((key: string) => (storeData as Record<string, unknown>)[key])
const storeSet = vi.fn((key: string, value: unknown) => {
  ;(storeData as Record<string, unknown>)[key] = value
})

vi.mock('../store', () => ({
  store: {
    get: (key: string) => storeGet(key),
    set: (key: string, value: unknown) => storeSet(key, value)
  }
}))

import {
  isPaidBillingStatus,
  getCachedMaxFileSize,
  getCachedEntitlement,
  setCachedEntitlementFromStatus,
  invalidateCachedEntitlementLimits,
  ENTITLEMENT_LIMITS_TTL_MS
} from './entitlement-cache'
import type { BillingStatus } from './paddle-billing'

function status(plan: string, statusValue: string, expiresAt: number | null = null): BillingStatus {
  return {
    plan: plan as BillingStatus['plan'],
    status: statusValue as BillingStatus['status'],
    source: 'paddle',
    email: null,
    limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
    usage: { storageUsed: 0 },
    expiresAt,
    canManageBilling: false
  }
}

describe('entitlement-cache', () => {
  beforeEach(() => {
    storeData.sync = {}
    vi.clearAllMocks()
  })

  it('isPaidBillingStatus is true only for a non-free active plan', () => {
    expect(isPaidBillingStatus(status('plus', 'active'))).toBe(true)
    expect(isPaidBillingStatus(status('pro', 'active'))).toBe(true)
    expect(isPaidBillingStatus(status('free', 'active'))).toBe(false)
    expect(isPaidBillingStatus(status('plus', 'canceled'))).toBe(false)
    expect(isPaidBillingStatus(status('plus', 'past_due'))).toBe(false)
  })

  it('isPaidBillingStatus is false for an active plan whose expiry has passed', () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(isPaidBillingStatus(status('plus', 'active', nowSeconds - 60))).toBe(false)
    expect(isPaidBillingStatus(status('plus', 'active', nowSeconds + 3600))).toBe(true)
  })

  it('getCachedEntitlement returns null when nothing cached', () => {
    expect(getCachedEntitlement()).toBeNull()
  })

  it('getCachedMaxFileSize returns the cached plan limit', () => {
    const s = status('plus', 'active')
    s.limits.maxFileSize = 5 * 1024 * 1024
    setCachedEntitlementFromStatus(s)
    expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)
  })

  it('getCachedMaxFileSize fails open once the cached limit is older than the TTL', () => {
    // The cache is only ever written by a user-triggered billing fetch — there is
    // no periodic refresh. A user who upgrades on the web, on another device, or
    // via a server-side grant keeps the old, smaller limit here forever. Past the
    // TTL the preflight must stop having an opinion and let the server decide,
    // otherwise we hard-block an upload the server would accept.
    storeData.sync = {
      entitlement: {
        isPaid: true,
        plan: 'plus',
        status: 'active',
        limits: { maxFileSize: 5 * 1024 * 1024 },
        cachedAt: Date.now() - ENTITLEMENT_LIMITS_TTL_MS - 1
      }
    }
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('getCachedMaxFileSize honours a cached limit that is still inside the TTL', () => {
    storeData.sync = {
      entitlement: {
        isPaid: true,
        plan: 'plus',
        status: 'active',
        limits: { maxFileSize: 5 * 1024 * 1024 },
        cachedAt: Date.now() - 1000
      }
    }
    expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)
  })

  it('getCachedMaxFileSize treats a store with no cachedAt as stale and fails open', () => {
    // Real users' electron-store files predate `cachedAt`. An entry with limits
    // but no timestamp is of unknown age, so it must be treated as stale — never
    // as fresh, which would resurrect the false-block for exactly the installs we
    // cannot re-date.
    storeData.sync = {
      entitlement: {
        isPaid: true,
        plan: 'plus',
        status: 'active',
        limits: { maxFileSize: 5 * 1024 * 1024 }
      }
    }
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('getCachedMaxFileSize fails open for a cachedAt in the future (clock moved)', () => {
    storeData.sync = {
      entitlement: {
        isPaid: true,
        plan: 'plus',
        status: 'active',
        limits: { maxFileSize: 5 * 1024 * 1024 },
        cachedAt: Date.now() + 60 * 60 * 1000
      }
    }
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('invalidateCachedEntitlementLimits drops the limit so the next preflight fails open', () => {
    const s = status('plus', 'active')
    s.limits.maxFileSize = 5 * 1024 * 1024
    setCachedEntitlementFromStatus(s)
    expect(getCachedMaxFileSize()).toBe(5 * 1024 * 1024)

    invalidateCachedEntitlementLimits()

    expect(getCachedMaxFileSize()).toBeNull()
    // Only the limits are dropped — the paid/plan facts stay, because
    // sync-core-handlers reads them to decide whether to start the runtime.
    const cached = getCachedEntitlement()
    expect(cached?.isPaid).toBe(true)
    expect(cached?.plan).toBe('plus')
    expect(cached?.limits).toBeUndefined()
  })

  it('invalidateCachedEntitlementLimits is a no-op on a cold cache', () => {
    expect(() => invalidateCachedEntitlementLimits()).not.toThrow()
    expect(getCachedEntitlement()).toBeNull()
  })

  it('getCachedMaxFileSize returns null on a cold cache', () => {
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('getCachedMaxFileSize returns null for a store written before limits existed', () => {
    // Real users' electron-store files have entitlement rows with no `limits`
    // key. Reading one must fail open (null = defer to the server), never block.
    storeData.sync = { entitlement: { isPaid: true, plan: 'plus', status: 'active' } }
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('getCachedMaxFileSize returns null for an implausible cached limit', () => {
    storeData.sync = {
      entitlement: { isPaid: true, plan: 'plus', status: 'active', limits: { maxFileSize: 0 } }
    }
    expect(getCachedMaxFileSize()).toBeNull()
  })

  it('setCachedEntitlementFromStatus writes a cache and getCachedEntitlement reads it', () => {
    const before = Date.now()
    const written = setCachedEntitlementFromStatus(status('plus', 'active'))
    expect(written).toMatchObject({
      isPaid: true,
      plan: 'plus',
      status: 'active',
      limits: { maxFileSize: 0 }
    })
    expect(getCachedEntitlement()).toMatchObject({
      isPaid: true,
      plan: 'plus',
      status: 'active',
      limits: { maxFileSize: 0 }
    })
    // Stamped so the reader can tell a fresh limit from an indefinitely-stale one.
    expect(written.cachedAt).toBeGreaterThanOrEqual(before)
    expect(getCachedEntitlement()?.cachedAt).toBe(written.cachedAt)
  })

  it('caches an unpaid status as isPaid=false', () => {
    setCachedEntitlementFromStatus(status('free', 'inactive'))
    expect(getCachedEntitlement()).toMatchObject({
      isPaid: false,
      plan: 'free',
      status: 'inactive',
      limits: { maxFileSize: 0 }
    })
  })
})
