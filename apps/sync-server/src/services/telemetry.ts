import { AppError, ErrorCodes } from '../lib/errors'
import { verifyAccessToken } from '../lib/jwt-verify'
import { getSyncEntitlement, type SyncEntitlementStatus, type SyncPlan } from './entitlements'

const requireHmacKey = (key: string): string => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Telemetry HMAC key is not configured', 500)
  }
  return key
}

export const hashTelemetryId = async (secret: string, id: string): Promise<string> => {
  const keyMaterial = requireHmacKey(secret)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(id))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface TelemetryAccount {
  /**
   * The RAW user id. Server-side only — it exists so the caller can read the
   * account's own row (see `resolveTelemetryPlan`). It must never be forwarded
   * to PostHog or written into a TransformContext; `accountHash` is the only
   * form allowed to leave this process. See ACCOUNT_HASH_PATTERN in
   * posthog-transform.ts for what happens if it does.
   */
  userId: string
  accountHash: string
}

/**
 * Resolves the OPTIONAL bearer that `/telemetry/*` and `/diagnostics/*` carry
 * into an account identity.
 *
 * These routes deliberately bypass the auth middleware — telemetry must never
 * be rejected for auth reasons — so identity here is best-effort: a missing,
 * malformed or expired token simply yields `undefined` and the caller reports
 * anonymously against its install hash.
 *
 * Hashing happens HERE, at the resolution boundary, so `accountHash` is the
 * only identity most call sites ever touch and a raw account id cannot drift
 * into PostHog, where an $identify merge would be permanent. `userId` is
 * returned alongside it strictly for server-side lookups (see
 * `resolveTelemetryPlan`) — reach for `resolveTelemetryAccountHash` unless you
 * genuinely need to query this user's own rows.
 *
 * Known, accepted limitation: identity is verified but NOT revocation-checked.
 * A revoked device's still-unexpired access token (≤15 min) can attribute
 * telemetry until it lapses. Telemetry is not an authorization decision, so a
 * per-batch device lookup is not worth the D1 read.
 */
export const resolveTelemetryAccount = async (
  authHeader: string | undefined,
  jwtPublicKey: string,
  hmacKey: string
): Promise<TelemetryAccount | undefined> => {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  try {
    const claims = await verifyAccessToken(authHeader.slice(7), jwtPublicKey)
    return { userId: claims.userId, accountHash: await hashTelemetryId(hmacKey, claims.userId) }
  } catch {
    return undefined
  }
}

export const resolveTelemetryAccountHash = async (
  authHeader: string | undefined,
  jwtPublicKey: string,
  hmacKey: string
): Promise<string | undefined> => {
  const account = await resolveTelemetryAccount(authHeader, jwtPublicKey, hmacKey)
  return account?.accountHash
}

export interface TelemetryPlan {
  plan: SyncPlan
  planStatus: SyncEntitlementStatus
}

/**
 * Reads the account's billing plan for telemetry segmentation.
 *
 * Fails CLOSED to `undefined`: `getSyncEntitlement` throws a 404 for a user id
 * that no longer has a row (deleted account with a still-valid token), and a
 * telemetry batch must never 500 for that. Losing the plan on a batch costs one
 * missing person property; throwing would drop the whole batch.
 */
export const resolveTelemetryPlan = async (
  db: D1Database,
  userId: string
): Promise<TelemetryPlan | undefined> => {
  try {
    const entitlement = await getSyncEntitlement(db, userId)
    return { plan: entitlement.plan, planStatus: entitlement.status }
  } catch {
    return undefined
  }
}
