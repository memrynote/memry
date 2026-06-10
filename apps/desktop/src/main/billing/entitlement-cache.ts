import { store, type CachedEntitlement } from '../store'
import type { BillingStatus } from './paddle-billing'

export type { CachedEntitlement }

export function isPaidBillingStatus(s: BillingStatus): boolean {
  return s.plan !== 'free' && s.status === 'active'
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
