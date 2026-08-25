import type { Context } from 'hono'

import { BOOTSTRAP_TOKEN_HEADER } from '@memry/contracts/bootstrap-api'
import { AppError, ErrorCodes } from '../lib/errors'
import type { GetElevatedLimits } from '../middleware/rate-limit'

/**
 * Bootstrap sessions (#1837) — stateless signed tokens + the rate-limit
 * elevation they unlock.
 *
 * TOKEN. HMAC-SHA256 over a base64url JSON payload, same shape as
 * checkout-token.ts and keyed by its own secret binding
 * (BOOTSTRAP_SESSION_HMAC_KEY). Per-purpose HMAC secrets are this codebase's
 * pattern (OTP_HMAC_KEY, WEBHOOK_HMAC_KEY, TELEMETRY_HMAC_KEY): sharing one
 * key across token classes would let a leak in any one of them forge all of
 * them. The binding is OPTIONAL — absent means this deployment has not opted
 * in, every endpoint answers a typed 501 exactly like presign-batch does, and
 * elevation returns null everywhere, so an unconfigured deployment behaves
 * byte-for-byte like today.
 *
 * STATE. Verification reads no database: exp is inside the signature, so an
 * expired token fails verification with zero I/O on the hot path. The one
 * thing statelessness cannot express — capping concurrent sessions per user —
 * lives in the `bootstrap_sessions` ledger (migration 0007), touched only at
 * issuance/renewal/close/revocation.
 *
 * ELEVATION. The limiter middleware asks `bootstrapRateLimitElevation` for a
 * multiplier per request; see BOOTSTRAP_ELEVATION_MULTIPLIERS for the
 * arithmetic. A missing/expired/forged/mismatched token degrades to null —
 * steady-state limits — and NEVER throws into the limiter: an invalid
 * bootstrap header must not be able to fail an unrelated sync request.
 */

export const BOOTSTRAP_SESSION_TTL_SECONDS = 60 * 60
/** Abuse guard: at most this many concurrently-open sessions per user. */
export const MAX_CONCURRENT_BOOTSTRAP_SESSIONS = 2
/** Renewal is requested this long before expiry (client-side scheduling hint too). */
export const BOOTSTRAP_RENEW_LEAD_SECONDS = 5 * 60

interface BootstrapTokenPayload {
  /** Token shape version, in case the payload ever grows. */
  v: 1
  userId: string
  deviceId: string
  vaultId: string
  jti: string
  iat: number
  exp: number
}

export interface BootstrapSession {
  userId: string
  deviceId: string
  vaultId: string
  jti: string
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Token codec (Web Crypto — Workers + Node 18+)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const base64UrlEncode = (value: Uint8Array | string): string => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// atob needs canonical padding, which base64url encoding strips.
const base64UrlDecodeBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const restored = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = atob(restored)
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

const hmacSha256 = async (secret: string, value: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Compact-token encoding for an already-assembled claim set. */
const mintToken = async (
  secret: string,
  session: BootstrapSession,
  issuedAt: number
): Promise<string> => {
  // Built field-by-field, not spread: the wire payload carries `exp`, while
  // BootstrapSession carries `expiresAt` — a spread here would silently mint
  // tokens without an exp claim (and verification would refuse every one).
  const payload: BootstrapTokenPayload = {
    v: 1,
    userId: session.userId,
    deviceId: session.deviceId,
    vaultId: session.vaultId,
    jti: session.jti,
    exp: session.expiresAt,
    iat: issuedAt
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = await hmacSha256(secret, encodedPayload)
  return `${encodedPayload}.${base64UrlEncode(signature)}`
}

/**
 * Mint one session token. `nowSeconds` is injectable for tests.
 * Returns the compact token plus the parsed claims (the caller persists the
 * ledger row).
 */
export const signBootstrapSession = async (
  secret: string,
  claims: Omit<BootstrapSession, 'expiresAt'>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ token: string; session: BootstrapSession }> => {
  const session: BootstrapSession = {
    ...claims,
    expiresAt: nowSeconds + BOOTSTRAP_SESSION_TTL_SECONDS
  }
  return { token: await mintToken(secret, session, nowSeconds), session }
}

/**
 * Verify a bootstrap token. Returns null on ANY failure — wrong secret,
 * tampered payload, expired, malformed, future-dated. Never throws: the
 * elevation path calls this per request and must degrade, not fail.
 */
export const verifyBootstrapSession = async (
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<BootstrapSession | null> => {
  try {
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const encodedPayload = token.slice(0, dot)
    const encodedSignature = token.slice(dot + 1)

    const expected = await hmacSha256(secret, encodedPayload)
    if (!constantTimeEqual(expected, base64UrlDecodeBytes(encodedSignature))) return null

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecodeBytes(encodedPayload))
    ) as Partial<BootstrapTokenPayload>

    if (
      payload.v !== 1 ||
      typeof payload.userId !== 'string' ||
      typeof payload.deviceId !== 'string' ||
      typeof payload.vaultId !== 'string' ||
      typeof payload.jti !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null
    }
    if (payload.exp <= nowSeconds) return null

    return {
      userId: payload.userId,
      deviceId: payload.deviceId,
      vaultId: payload.vaultId,
      jti: payload.jti,
      expiresAt: payload.exp
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Rate-limit elevation
// ---------------------------------------------------------------------------

/**
 * Per-bucket multipliers for an active bootstrap session. Pull-only by
 * design: pushes keep their abuse ceilings untouched.
 *
 * Arithmetic vs server budgets (paid Workers plan, 1000 subrequests and D1
 * batched statements per invocation; each request here is its OWN invocation):
 *
 *   crdt_pull        x5  600 → 3000/min. One indexed D1 read (+≤1 R2 read)
 *                        per GET. Client sweep pacing divides its 50%-margin
 *                        slices by the same factor, so real traffic lands
 *                        ~1500/min with the ceiling as safety margin.
 *   crdt_batch_pull  x5   30 →  150/min. One indexed query per POST; the
 *                        client spends ~3/min elevated (4s floor ÷ 5).
 *   blob_download    x5  600 → 3000/min. One indexed D1 row + one R2 class-B
 *                        read per chunk GET. The #1829 pacer rides 150/min × 5
 *                        = 750/min against it — half the ceiling.
 *   sync_pull        x3  120 →  360/min. The expensive one: up to 100 R2
 *                        reads per POST (pullItems caps concurrency at 25),
 *                        so 6/s × bursts of 25 ≈ 150 R2 ops/s worst case —
 *                        bounded by TTL (≤60 min) and the 2-session cap, and
 *                        still below what a single warm push batch spends.
 *   sync_changes     x3   60 →  180/min. Refs-only pages (no payloads), one
 *                        indexed scan per page of 500.
 *   sync_manifest    x3   30 →   90/min. Paginated keyset scans since the
 *                        quick-wins pagination landed.
 *
 * Everything else (pushes, uploads, status, vaults, ws, presign issuance)
 * stays at its steady-state ceiling whether or not a valid token is present:
 * bootstrap is a pull problem, and presign-batch already amortizes one call
 * across ≤1024 chunk URLs per TTL window.
 */
export const BOOTSTRAP_ELEVATION_MULTIPLIERS: Record<string, number> = {
  crdt_pull: 5,
  crdt_batch_pull: 5,
  blob_download: 5,
  sync_pull: 3,
  sync_changes: 3,
  sync_manifest: 3
}

const matchesRequestIdentity = (
  c: Pick<
    Context<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>,
    'get'
  >,
  session: BootstrapSession
): boolean =>
  session.userId === c.get('userId') &&
  session.deviceId === c.get('deviceId') &&
  session.vaultId === c.get('vaultId')

/**
 * The seam implementation handed to every eligible bucket's createRateLimiter.
 *
 * Fast path first: no header → null with zero work (the old-clients-never-
 * send compat guarantee). Any error inside verification collapses to null.
 * Identity is re-bound to THIS request's authenticated context, so a token
 * replayed from another device (or another vault) elevates nothing.
 */
export const bootstrapRateLimitElevation: GetElevatedLimits = async (c, bucket) => {
  const secret = c.env.BOOTSTRAP_SESSION_HMAC_KEY
  const token = c.req.header(BOOTSTRAP_TOKEN_HEADER)
  if (!secret || !token) return null

  const multiplier = BOOTSTRAP_ELEVATION_MULTIPLIERS[bucket.keyPrefix]
  if (multiplier === undefined) return null

  const session = await verifyBootstrapSession(secret, token)
  if (!session || !matchesRequestIdentity(c, session)) return null

  return multiplier
}

// ---------------------------------------------------------------------------
// Ledger operations (issuance cap, renewal, close, revocation)
// ---------------------------------------------------------------------------

/** Has this device never completed a pull for this vault? That is "fresh". */
export const isFreshDeviceForVault = async (
  db: D1Database,
  userId: string,
  deviceId: string,
  vaultId: string
): Promise<boolean> => {
  const row = await db
    .prepare(
      'SELECT last_cursor_seen FROM device_sync_state WHERE device_id = ? AND user_id = ? AND vault_id = ?'
    )
    .bind(deviceId, userId, vaultId)
    .first<{ last_cursor_seen: number | null }>()
  // updateDeviceCursor only writes when a changes page actually delivered
  // items, so an absent row (or a NULL/0 cursor) is a genuine never-pulled
  // device — the same signal the client's LAST_CURSOR gate uses.
  return !row || row.last_cursor_seen == null || row.last_cursor_seen === 0
}

export interface OpenBootstrapSessionResult {
  session: BootstrapSession
  token: string
}

export const openBootstrapSession = async (
  db: D1Database,
  secret: string,
  identity: { userId: string; deviceId: string; vaultId: string }
): Promise<OpenBootstrapSessionResult> => {
  if (!(await isFreshDeviceForVault(db, identity.userId, identity.deviceId, identity.vaultId))) {
    throw new AppError(
      ErrorCodes.BOOTSTRAP_NOT_ELIGIBLE,
      'This device has already synced this vault',
      409
    )
  }

  const now = Math.floor(Date.now() / 1000)
  // Lazy prune keeps the count honest without waiting for cron, scoped to this
  // user so the statement stays on the (user_id, expires_at) index.
  await db
    .prepare('DELETE FROM bootstrap_sessions WHERE user_id = ? AND expires_at < ?')
    .bind(identity.userId, now)
    .run()

  const counted = await db
    .prepare('SELECT COUNT(*) AS count FROM bootstrap_sessions WHERE user_id = ?')
    .bind(identity.userId)
    .first<{ count: number }>()
  if ((counted?.count ?? 0) >= MAX_CONCURRENT_BOOTSTRAP_SESSIONS) {
    throw new AppError(
      ErrorCodes.BOOTSTRAP_SESSION_LIMIT,
      'Too many concurrent bootstrap sessions',
      429
    )
  }

  const { token, session } = await signBootstrapSession(
    secret,
    { ...identity, jti: crypto.randomUUID() },
    now
  )
  await db
    .prepare(
      `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(session.jti, identity.userId, identity.deviceId, identity.vaultId, session.expiresAt, now)
    .run()

  return { session, token }
}

/**
 * Sliding renewal: a still-valid token exchanges for a fresh TTL under the
 * SAME jti, so the ledger row simply extends (no insert/delete churn). An
 * expired or revoked token is refused — renewal is not resurrection.
 */
export const renewBootstrapSession = async (
  db: D1Database,
  secret: string,
  token: string
): Promise<OpenBootstrapSessionResult> => {
  const now = Math.floor(Date.now() / 1000)
  const existing = await verifyBootstrapSession(secret, token, now)
  if (!existing) {
    throw new AppError(ErrorCodes.BOOTSTRAP_SESSION_INVALID, 'Invalid bootstrap session', 401)
  }

  const row = await db
    .prepare('SELECT jti FROM bootstrap_sessions WHERE jti = ?')
    .bind(existing.jti)
    .first<{ jti: string }>()
  if (!row) {
    throw new AppError(
      ErrorCodes.BOOTSTRAP_SESSION_INVALID,
      'Bootstrap session was closed or revoked',
      401
    )
  }

  const session: BootstrapSession = { ...existing, expiresAt: now + BOOTSTRAP_SESSION_TTL_SECONDS }
  await db
    .prepare('UPDATE bootstrap_sessions SET expires_at = ? WHERE jti = ?')
    .bind(session.expiresAt, session.jti)
    .run()

  return { session, token: await mintToken(secret, session, now) }
}

export const closeBootstrapSession = async (
  db: D1Database,
  secret: string,
  token: string
): Promise<void> => {
  const existing = await verifyBootstrapSession(secret, token)
  if (!existing) return // already expired/invalid — closing is idempotent
  await db.prepare('DELETE FROM bootstrap_sessions WHERE jti = ?').bind(existing.jti).run()
}
