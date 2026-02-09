import { importPKCS8, SignJWT } from 'jose'

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
  signingKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const privateKey = await importPKCS8(signingKeyPem, ALGORITHM)

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
  signingKeyPem: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const oldTokenHash = await hashToken(oldToken)

  const existing = await db
    .prepare(
      'SELECT id FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL AND expires_at > ?'
    )
    .bind(oldTokenHash, userId, deviceId, new Date().toISOString())
    .first<{ id: string }>()

  if (!existing) {
    await db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ?')
      .bind(new Date().toISOString(), userId, deviceId)
      .run()

    throw new Error('Invalid refresh token — all device tokens revoked')
  }

  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), existing.id)
    .run()

  const tokens = await issueTokens(userId, deviceId, signingKeyPem)
  const newHash = await hashToken(tokens.refreshToken)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  await db
    .prepare(
      'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), userId, deviceId, newHash, expiresAt, new Date().toISOString())
    .run()

  return tokens
}

export const revokeDeviceTokens = async (db: D1Database, deviceId: string): Promise<void> => {
  await db
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), deviceId)
    .run()
}
