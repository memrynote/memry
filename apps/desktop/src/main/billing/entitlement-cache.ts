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
    status: s.status,
    // Carry the file-size limit so an attachment upload can be rejected before
    // the expensive read+hash+encrypt pass instead of after a server 413.
    limits: { maxFileSize: s.limits.maxFileSize }
  }
  store.set('sync', { ...store.get('sync'), entitlement: cached })
  return cached
}

/**
 * Cached plan file-size limit, or null when unknown.
 *
 * Null means "no opinion, let the server decide": the cache is only populated on
 * a billing fetch, so it is legitimately absent on a cold start or on a store
 * written by an older version. Callers must fail open — never block an upload on
 * a cold cache.
 */
export function getCachedMaxFileSize(): number | null {
  const cached = getCachedEntitlement()
  const maxFileSize = cached?.limits?.maxFileSize
  if (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    return null
  }
  return maxFileSize
}
