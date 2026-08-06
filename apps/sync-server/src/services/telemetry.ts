import { AppError, ErrorCodes } from '../lib/errors'
import { verifyAccessToken } from '../lib/jwt-verify'

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

/**
 * Resolves the OPTIONAL bearer that `/telemetry/*` and `/diagnostics/*` carry
 * into an HMAC'd account id.
 *
 * These routes deliberately bypass the auth middleware — telemetry must never
 * be rejected for auth reasons — so identity here is best-effort: a missing,
 * malformed or expired token simply yields `undefined` and the caller reports
 * anonymously against its install hash.
 *
 * Returns the HASH, never the raw user id. Hashing at the resolution boundary
 * (rather than at each call site) is what keeps a raw account id from ever
 * reaching PostHog, where an $identify merge would be permanent.
 *
 * Known, accepted limitation: identity is verified but NOT revocation-checked.
 * A revoked device's still-unexpired access token (≤15 min) can attribute
 * telemetry until it lapses. Telemetry is not an authorization decision, so a
 * per-batch device lookup is not worth the D1 read.
 */
export const resolveTelemetryAccountHash = async (
  authHeader: string | undefined,
  jwtPublicKey: string,
  hmacKey: string
): Promise<string | undefined> => {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  try {
    const claims = await verifyAccessToken(authHeader.slice(7), jwtPublicKey)
    return await hashTelemetryId(hmacKey, claims.userId)
  } catch {
    return undefined
  }
}
