import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

import { AppError, ErrorCodes } from '../lib/errors'
import { getPrivateKey } from '../lib/jwt-keys'

const ISSUER = 'memry-sync'
const AUDIENCE = 'memry-client'
const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY = '7d'
const ALGORITHM = 'EdDSA'

const hashToken = async (token: string): Promise<string> => {
  const encoded = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const signToken = async (
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  expiry: string
): Promise<string> =>
  new SignJWT({ jti: crypto.randomUUID(), ...claims })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiry)
    .sign(privateKey)

const generateTokens = async (
  userId: string,
  deviceId: string,
  privateKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const privateKey = await getPrivateKey(privateKeyPem)

  const accessToken = await signToken(
    { sub: userId, device_id: deviceId, type: 'access' },
    privateKey,
    ACCESS_TOKEN_EXPIRY
  )

  const refreshToken = await signToken(
    { sub: userId, device_id: deviceId, type: 'refresh' },
    privateKey,
    REFRESH_TOKEN_EXPIRY
  )

  return { accessToken, refreshToken }
}

export const issueTokens = async (
  db: D1Database,
  userId: string,
  deviceId: string,
  privateKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const tokens = await generateTokens(userId, deviceId, privateKeyPem)

  const tokenHash = await hashToken(tokens.refreshToken)
  const nowEpoch = Math.floor(Date.now() / 1000)
  const expiresAt = nowEpoch + 7 * 24 * 60 * 60

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, deviceId, tokenHash, expiresAt, nowEpoch)
    .run()

  return tokens
}

// How long a client may retry with a refresh token the server already rotated.
// The client lost the response (its main thread stalled past the request
// timeout) and still holds the old token. The retry is honored only while the
// token that rotation issued is unused, so a reuse after the successor was
// spent is still theft. Counted from the first rotation; retries do not extend
// it. Minutes, not seconds: the stalls that lose these responses last minutes.
const ROTATION_GRACE_SECONDS = 15 * 60
const MAX_ROTATION_ATTEMPTS = 3

/**
 * Retires `revokeId` and inserts its successor in one atomic batch. A grace
 * re-issue also passes the token the client presented as `presentedId`, so it
 * now names the new successor and a further retry with it is still honored.
 *
 * The retire is conditional on `revokeId` still being live, and the other
 * writes only land when it did, so of two requests racing on one token exactly
 * one rotates it. The other gets 'lost' and re-reads.
 */
const tryRotateBatch = async (
  db: D1Database,
  revokeId: string,
  presentedId: string | null,
  userId: string,
  deviceId: string,
  newHash: string,
  expiresAt: number,
  nowEpoch: number
): Promise<'rotated' | 'lost' | 'collision'> => {
  const successorId = crypto.randomUUID()
  const wonRetire = 'EXISTS (SELECT 1 FROM refresh_tokens WHERE id = ? AND replaced_by = ?)'
  try {
    const results = await db.batch([
      db
        .prepare(
          'UPDATE refresh_tokens SET revoked = 1, rotated_at = ?, replaced_by = ? WHERE id = ? AND revoked = 0'
        )
        .bind(nowEpoch, successorId, revokeId),
      ...(presentedId
        ? [
            db
              .prepare(`UPDATE refresh_tokens SET replaced_by = ? WHERE id = ? AND ${wonRetire}`)
              .bind(successorId, presentedId, revokeId, successorId)
          ]
        : []),
      db
        .prepare(
          `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${wonRetire}`
        )
        .bind(successorId, userId, deviceId, newHash, expiresAt, nowEpoch, revokeId, successorId)
    ])
    return results.at(-1)?.meta.changes === 1 ? 'rotated' : 'lost'
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT')) {
      return 'collision'
    }
    throw err
  }
}

const getLatestActiveTokenId = async (
  db: D1Database,
  userId: string,
  deviceId: string,
  nowEpoch: number
): Promise<string | null> => {
  const current = await db
    .prepare(
      'SELECT id FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
    )
    .bind(userId, deviceId, nowEpoch)
    .first<{ id: string }>()

  return current?.id ?? null
}

/** The new pair, or null when a concurrent request rotated `initialRevokeId` first. */
const rotateWithRetry = async (
  db: D1Database,
  initialRevokeId: string,
  presentedId: string | null,
  userId: string,
  deviceId: string,
  privateKeyPem: string,
  nowEpoch: number
): Promise<{ accessToken: string; refreshToken: string } | null> => {
  const expiresAt = nowEpoch + 7 * 24 * 60 * 60
  let revokeId = initialRevokeId

  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
    const tokens = await generateTokens(userId, deviceId, privateKeyPem)
    const newHash = await hashToken(tokens.refreshToken)
    const outcome = await tryRotateBatch(
      db,
      revokeId,
      presentedId,
      userId,
      deviceId,
      newHash,
      expiresAt,
      nowEpoch
    )
    if (outcome === 'rotated') return tokens
    if (outcome === 'lost') return null

    const currentTokenId = await getLatestActiveTokenId(db, userId, deviceId, nowEpoch)
    if (currentTokenId) {
      revokeId = currentTokenId
    }
  }

  throw new AppError(
    ErrorCodes.AUTH_TOKEN_ROTATION_FAILED,
    'Token rotation failed after retries',
    500
  )
}

/**
 * Which row a refresh with this token retires: the token itself while it is
 * live, or the unused successor of a rotation whose answer was lost. Null for
 * any other reuse.
 */
const findRotationTarget = async (
  db: D1Database,
  tokenHash: string,
  userId: string,
  deviceId: string,
  nowEpoch: number
): Promise<{ revokeId: string; presentedId: string | null } | null> => {
  const existing = await db
    .prepare(
      'SELECT id FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND device_id = ? AND revoked = 0 AND expires_at > ?'
    )
    .bind(tokenHash, userId, deviceId, nowEpoch)
    .first<{ id: string }>()
  if (existing) return { revokeId: existing.id, presentedId: null }

  // A rotated token whose successor nobody has used yet: the client that
  // rotated it never received the answer. Re-issue in place of that successor.
  const lostRotation = await db
    .prepare(
      `SELECT presented.id AS presentedId, successor.id AS successorId
       FROM refresh_tokens presented
       JOIN refresh_tokens successor ON successor.id = presented.replaced_by
       WHERE presented.token_hash = ? AND presented.user_id = ? AND presented.device_id = ?
         AND presented.revoked = 1 AND presented.rotated_at > ?
         AND successor.revoked = 0 AND successor.expires_at > ?`
    )
    .bind(tokenHash, userId, deviceId, nowEpoch - ROTATION_GRACE_SECONDS, nowEpoch)
    .first<{ presentedId: string; successorId: string }>()
  return lostRotation
    ? { revokeId: lostRotation.successorId, presentedId: lostRotation.presentedId }
    : null
}

export const rotateRefreshToken = async (
  db: D1Database,
  oldToken: string,
  userId: string,
  deviceId: string,
  privateKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const oldTokenHash = await hashToken(oldToken)
  const nowEpoch = Math.floor(Date.now() / 1000)

  // A request that loses the race for its target re-reads: the winner's
  // rotation now makes it a lost-response retry, or theft.
  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
    const target = await findRotationTarget(db, oldTokenHash, userId, deviceId, nowEpoch)
    if (!target) {
      // Any other reuse is theft and ends the device's session.
      await db
        .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND device_id = ?')
        .bind(userId, deviceId)
        .run()
      throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid refresh token', 401)
    }

    const tokens = await rotateWithRetry(
      db,
      target.revokeId,
      target.presentedId,
      userId,
      deviceId,
      privateKeyPem,
      nowEpoch
    )
    if (tokens) return tokens
  }

  throw new AppError(
    ErrorCodes.AUTH_TOKEN_ROTATION_FAILED,
    'Token rotation failed after retries',
    500
  )
}

export const revokeDeviceTokens = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0')
    .bind(deviceId)
    .run()
}

const SETUP_TOKEN_EXPIRY = '5m'

/**
 * How long the setup grant as a whole stays renewable, measured from the
 * original sign-in. The token itself still lives 5 minutes; this only bounds
 * how long the device that committed its key at sign-in may ask for a fresh
 * one (#1202: finishing a reinstall means finding a 24-word recovery phrase,
 * which routinely outlasts five minutes).
 *
 * Renewal is NOT bearer-redeemable — it needs a signature from the committed
 * device key — so this window governs an attacker who holds the token *and*
 * that device's private key, i.e. someone already inside the OS keychain where
 * the master key lives too.
 */
export const SETUP_TOKEN_RENEWAL_WINDOW_SECONDS = 24 * 60 * 60

export interface SetupTokenBinding {
  /** Base64 Ed25519 public key allowed to renew this grant. */
  devicePublicKey?: string
  /** Epoch seconds; inherited by renewals so the chain cannot outlive it. */
  renewableUntil?: number
}

export const signSetupToken = async (
  userId: string,
  privateKeyPem: string,
  sessionNonce?: string,
  binding?: SetupTokenBinding
): Promise<string> => {
  const privateKey = await getPrivateKey(privateKeyPem)
  const claims: Record<string, unknown> = {
    sub: userId,
    type: 'setup',
    jti: crypto.randomUUID()
  }
  if (sessionNonce) {
    claims.session_nonce = sessionNonce
  }
  if (binding?.devicePublicKey) {
    claims.device_public_key = binding.devicePublicKey
    claims.renewable_until =
      binding.renewableUntil ?? Math.floor(Date.now() / 1000) + SETUP_TOKEN_RENEWAL_WINDOW_SECONDS
  }
  return signToken(claims, privateKey, SETUP_TOKEN_EXPIRY)
}

export interface RenewableSetupTokenClaims {
  userId: string
  jti: string
  devicePublicKey: string
  renewableUntil: number
  sessionNonce?: string
}

/**
 * Verify a setup token presented for renewal. The signature, issuer, audience
 * and algorithm are checked in full; only `exp` is allowed to be in the past,
 * and only as far back as the grant's own `renewable_until` claim — which is
 * signed, so a caller cannot widen it.
 */
export const verifyRenewableSetupToken = async (
  token: string,
  publicKey: CryptoKey
): Promise<RenewableSetupTokenClaims> => {
  let payload: JWTPayload
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      // Bounded by renewable_until below; this only stops jose rejecting the
      // token before we can read its claims.
      clockTolerance: SETUP_TOKEN_RENEWAL_WINDOW_SECONDS
    })
    payload = result.payload
  } catch {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid setup token', 401)
  }

  const devicePublicKey = payload.device_public_key
  const renewableUntil = payload.renewable_until

  if (
    payload.type !== 'setup' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof devicePublicKey !== 'string' ||
    typeof renewableUntil !== 'number'
  ) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Setup token is not renewable', 401)
  }

  if (Math.floor(Date.now() / 1000) >= renewableUntil) {
    throw new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 'Setup token has expired', 401)
  }

  return {
    userId: payload.sub,
    jti: payload.jti,
    devicePublicKey,
    renewableUntil,
    sessionNonce: typeof payload.session_nonce === 'string' ? payload.session_nonce : undefined
  }
}
