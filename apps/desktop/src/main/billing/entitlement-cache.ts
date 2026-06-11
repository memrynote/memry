import { store, type CachedEntitlement } from '../store'
import type { BillingStatus } from './paddle-billing'

export type { CachedEntitlement }

export function isPaidBillingStatus(s: BillingStatus): boolean {
  if (s.plan === 'free' || s.status !== 'active') return false
  // Mirror the server gate (isPaidSyncEntitlementActive): an expired-but-still-active
  // entitlement is not paid, otherwise the runtime starts and every request 402s.
  if (s.expiresAt !== null && s.expiresAt <= Math.floor(Date.now() / 1000)) return false
  return true
}

export function getCachedEntitlement(): CachedEntitlement | null {
  return store.get('sync').entitlement ?? null
}

export function setCachedEntitlementFromStatus(s: BillingStatus): CachedEntitlement {
  const cached: CachedEntitlement = {
    isPaid: isPaidBillingStatus(s),
    plan: s.plan,
    status: s.status
  }
  store.set('sync', { ...store.get('sync'), entitlement: cached })
  return cached
}
