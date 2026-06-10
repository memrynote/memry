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
  getCachedEntitlement,
  setCachedEntitlementFromStatus
} from './entitlement-cache'
import type { BillingStatus } from './paddle-billing'

function status(plan: string, statusValue: string): BillingStatus {
  return {
    plan: plan as BillingStatus['plan'],
    status: statusValue as BillingStatus['status'],
    source: 'paddle',
    email: null,
    limits: { storageLimit: 0, maxFileSize: 0, maxVaults: 0, versionHistoryDays: 0 },
    usage: { storageUsed: 0 },
    expiresAt: null,
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

  it('getCachedEntitlement returns null when nothing cached', () => {
    expect(getCachedEntitlement()).toBeNull()
  })

  it('setCachedEntitlementFromStatus writes a cache and getCachedEntitlement reads it', () => {
    const written = setCachedEntitlementFromStatus(status('plus', 'active'))
    expect(written).toEqual({ isPaid: true, plan: 'plus', status: 'active' })
    expect(getCachedEntitlement()).toEqual({ isPaid: true, plan: 'plus', status: 'active' })
  })

  it('caches an unpaid status as isPaid=false', () => {
    setCachedEntitlementFromStatus(status('free', 'inactive'))
    expect(getCachedEntitlement()).toEqual({ isPaid: false, plan: 'free', status: 'inactive' })
  })
})
