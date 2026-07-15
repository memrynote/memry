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

/**
 * How long a cached plan limit may be trusted by the upload preflight.
 *
 * The cache is only written by a user-triggered billing fetch — there is no
 * periodic refresh — so it can otherwise sit wrong forever after an upgrade made
 * on the web, on another device, or by a server-side entitlement grant. Because
 * the preflight is only an optimization (it skips a pointless read+hash+encrypt
 * of a file the server would reject anyway), the cost of expiring too eagerly is
 * some wasted CPU on a doomed upload, while the cost of expiring too late is a
 * false block with no recovery path. 24h keeps the optimization useful for the
 * common same-session case and bounds the false-block window to a day.
 */
export const ENTITLEMENT_LIMITS_TTL_MS = 24 * 60 * 60 * 1000

export function setCachedEntitlementFromStatus(s: BillingStatus): CachedEntitlement {
  const cached: CachedEntitlement = {
    isPaid: isPaidBillingStatus(s),
    plan: s.plan,
    status: s.status,
    // Carry the file-size limit so an attachment upload can be rejected before
    // the expensive read+hash+encrypt pass instead of after a server 413.
    limits: { maxFileSize: s.limits.maxFileSize },
    cachedAt: Date.now()
  }
  store.set('sync', { ...store.get('sync'), entitlement: cached })
  return cached
}

/**
 * Drop the cached plan limits, keeping the paid/plan facts that
 * sync-core-handlers reads to decide whether to start the runtime.
 *
 * Called when the server rejects an upload on its own file-size limit: that is
 * proof the cached number disagrees with the authority, so the next preflight
 * must have no opinion (fail open) until a billing fetch repopulates it.
 */
export function invalidateCachedEntitlementLimits(): void {
  const cached = getCachedEntitlement()
  if (!cached) return
  const { limits: _limits, cachedAt: _cachedAt, ...rest } = cached
  store.set('sync', { ...store.get('sync'), entitlement: rest })
}

/**
 * Cached plan file-size limit, or null when unknown or stale.
 *
 * Null means "no opinion, let the server decide". The server is always the
 * authority; this cache only ever lets a caller skip work that would be wasted.
 * It is legitimately absent on a cold start or on a store written by an older
 * version, and it goes stale because nothing refreshes it in the background —
 * so every caller must fail open rather than block.
 */
export function getCachedMaxFileSize(): number | null {
  const cached = getCachedEntitlement()
  const maxFileSize = cached?.limits?.maxFileSize
  if (typeof maxFileSize !== 'number' || !Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    return null
  }

  // No cachedAt at all = a store written before this field existed. Its age is
  // unknowable, so it is stale by definition — never treat it as fresh.
  const cachedAt = cached?.cachedAt
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt)) return null

  // A cachedAt in the future means the clock moved under us; age is meaningless,
  // so fail open rather than trust it until the TTL "expires".
  const age = Date.now() - cachedAt
  if (age < 0 || age > ENTITLEMENT_LIMITS_TTL_MS) return null

  return maxFileSize
}
