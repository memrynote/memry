import { importPKCS8, SignJWT } from 'jose'

import { AppError, ErrorCodes } from '../lib/errors'

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
  new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiry)
    .sign(privateKey)

export const issueTokens = async (
  userId: string,
  deviceId: string,
  privateKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const privateKey = await importPKCS8(privateKeyPem, ALGORITHM)

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
    await db
      .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND device_id = ?')
      .bind(userId, deviceId)
      .run()

    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid refresh token', 401)
  }

  await db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').bind(existing.id).run()

  const tokens = await issueTokens(userId, deviceId, privateKeyPem)
  const newHash = await hashToken(tokens.refreshToken)
  const expiresAt = nowEpoch + 7 * 24 * 60 * 60

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, deviceId, newHash, expiresAt, nowEpoch)
    .run()

  return tokens
}

export const revokeDeviceTokens = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0')
    .bind(deviceId)
    .run()
}
