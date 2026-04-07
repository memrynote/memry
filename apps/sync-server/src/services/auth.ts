import { SignJWT } from 'jose'

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

// Grace window for legitimate retry scenarios (e.g., client lost response mid-rotation).
// Kept short to narrow the replay window for an intercepted refresh token.
const ROTATION_GRACE_SECONDS = 10
const MAX_ROTATION_ATTEMPTS = 3

const tryRotateBatch = async (
  db: D1Database,
  revokeId: string,
  userId: string,
  deviceId: string,
  newHash: string,
  expiresAt: number,
  nowEpoch: number
): Promise<boolean> => {
  try {
    await db.batch([
      db
        .prepare('UPDATE refresh_tokens SET revoked = 1, rotated_at = ? WHERE id = ?')
        .bind(nowEpoch, revokeId),
      db
        .prepare(
          'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(crypto.randomUUID(), userId, deviceId, newHash, expiresAt, nowEpoch)
    ])
    return true
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT')) {
      return false
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

const rotateWithRetry = async (
  db: D1Database,
  initialRevokeId: string,
  userId: string,
  deviceId: string,
  privateKeyPem: string,
  nowEpoch: number
): Promise<{ accessToken: string; refreshToken: string }> => {
  const expiresAt = nowEpoch + 7 * 24 * 60 * 60
  let revokeId = initialRevokeId

  for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
    const tokens = await generateTokens(userId, deviceId, privateKeyPem)
    const newHash = await hashToken(tokens.refreshToken)
    const inserted = await tryRotateBatch(
      db,
      revokeId,
      userId,
      deviceId,
      newHash,
      expiresAt,
      nowEpoch
    )
    if (inserted) return tokens

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

export const rotateRefreshToken = async (
  db: D1Database,
  oldToken: string,
  userId: string,
  deviceId: string,
  privateKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const oldTokenHash = await hashToken(oldToken)
  const nowEpoch = Math.floor(Date.now() / 1000)

  const existing = await db
    .prepare(
      'SELECT id FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND device_id = ? AND revoked = 0 AND expires_at > ?'
    )
    .bind(oldTokenHash, userId, deviceId, nowEpoch)
    .first<{ id: string }>()

  if (!existing) {
    const recentlyRotated = await db
      .prepare(
        'SELECT id FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND device_id = ? AND revoked = 1 AND rotated_at IS NOT NULL AND rotated_at > ?'
      )
      .bind(oldTokenHash, userId, deviceId, nowEpoch - ROTATION_GRACE_SECONDS)
      .first<{ id: string }>()

    if (recentlyRotated) {
      const currentTokenId = await getLatestActiveTokenId(db, userId, deviceId, nowEpoch)

      if (currentTokenId) {
        return rotateWithRetry(db, currentTokenId, userId, deviceId, privateKeyPem, nowEpoch)
      }
    }

    await db
      .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .run()

    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid refresh token', 401)
  }

  return rotateWithRetry(db, existing.id, userId, deviceId, privateKeyPem, nowEpoch)
}

export const revokeDeviceTokens = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0')
    .bind(deviceId)
    .run()
}

const SETUP_TOKEN_EXPIRY = '5m'

export const signSetupToken = async (
  userId: string,
  privateKeyPem: string,
  sessionNonce?: string
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
  return signToken(claims, privateKey, SETUP_TOKEN_EXPIRY)
}
