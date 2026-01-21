/**
 * T031a: Refresh Token Rotation
 * T031b: Token Revocation on Device Removal
 *
 * Implements secure refresh token lifecycle with rotation and revocation.
 */

import * as jose from 'jose'
import {
  SyncError,
  ErrorCode,
  refreshTokenInvalid,
  refreshTokenExpired,
  refreshTokenRevoked,
} from '../lib/errors'

/**
 * JWT configuration constants.
 */
export const JWT_ALGORITHM = 'HS256'
export const ACCESS_TOKEN_EXPIRY = '15m'
export const REFRESH_TOKEN_EXPIRY_DAYS = 7
export const REFRESH_TOKEN_GRACE_PERIOD_MS = 5 * 60 * 1000 // 5 minutes

/**
 * JWT payload structure.
 */
export interface JWTPayload {
  sub: string // user_id
  deviceId: string // device_id
  iat: number // issued at (seconds)
  exp: number // expiration (seconds)
}

/**
 * Result of token refresh operation.
 */
export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: number // Unix timestamp (ms)
  refreshTokenExpiresAt: number // Unix timestamp (ms)
}

/**
 * Refresh token record in database.
 */
interface RefreshTokenRecord {
  id: string
  user_id: string
  device_id: string
  token_hash: string
  expires_at: number
  rotated_at: number | null
  revoked_at: number | null
  created_at: number
}

/**
 * Hash a token using SubtleCrypto (edge-compatible).
 *
 * @param token - The token to hash
 * @returns Hex-encoded hash
 */
export const hashToken = async (token: string): Promise<string> => {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a new access token.
 *
 * @param userId - User ID for the token
 * @param deviceId - Device ID for the token
 * @param secret - JWT signing secret
 * @returns Signed JWT access token
 */
export const generateAccessToken = async (
  userId: string,
  deviceId: string,
  secret: string
): Promise<string> => {
  const secretKey = new TextEncoder().encode(secret)

  return await new jose.SignJWT({ deviceId })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(secretKey)
}

/**
 * Generate a new refresh token (random string).
 *
 * @returns Random refresh token
 */
export const generateRefreshToken = (): string => {
  // Use crypto.randomUUID() twice for 256 bits of entropy
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`
}

/**
 * Create and store a new refresh token in the database.
 *
 * @param db - D1 database
 * @param userId - User ID
 * @param deviceId - Device ID
 * @returns The refresh token string (to send to client)
 */
export const createRefreshToken = async (
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<string> => {
  const token = generateRefreshToken()
  const tokenHash = await hashToken(token)
  const now = Date.now()
  const expiresAt = now + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  const id = crypto.randomUUID()

  await db
    .prepare(
      `
      INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
    .bind(id, userId, deviceId, tokenHash, expiresAt, now)
    .run()

  return token
}

/**
 * Rotate a refresh token - validates the old token, marks it as rotated,
 * and issues new access and refresh tokens.
 *
 * Implements grace period: old token is still valid for 5 minutes after rotation
 * to handle race conditions in concurrent requests.
 *
 * @param db - D1 database
 * @param oldToken - The refresh token to rotate
 * @param jwtSecret - JWT signing secret
 * @returns New token pair
 */
export const rotateRefreshToken = async (
  db: D1Database,
  oldToken: string,
  jwtSecret: string
): Promise<RefreshTokenResult> => {
  const tokenHash = await hashToken(oldToken)
  const now = Date.now()

  // Find the refresh token
  const record = await db
    .prepare(
      `
      SELECT id, user_id, device_id, expires_at, rotated_at, revoked_at
      FROM refresh_tokens
      WHERE token_hash = ?
    `
    )
    .bind(tokenHash)
    .first<RefreshTokenRecord>()

  if (!record) {
    throw refreshTokenInvalid()
  }

  // Check if revoked
  if (record.revoked_at !== null) {
    throw refreshTokenRevoked()
  }

  // Check if expired
  if (record.expires_at < now) {
    throw refreshTokenExpired()
  }

  // Check if already rotated (but still within grace period)
  if (record.rotated_at !== null) {
    const gracePeriodEnd = record.rotated_at + REFRESH_TOKEN_GRACE_PERIOD_MS
    if (now > gracePeriodEnd) {
      // Grace period expired - this could indicate token theft
      // Revoke all tokens for this device as a security measure
      await revokeDeviceTokens(db, record.device_id)
      throw new SyncError(
        'Refresh token reuse detected - all tokens revoked',
        ErrorCode.AUTH_REFRESH_TOKEN_REVOKED,
        401
      )
    }
    // Within grace period - allow the request but don't issue new tokens
    // Just return new access token with the same refresh token
    const accessToken = await generateAccessToken(record.user_id, record.device_id, jwtSecret)
    const accessTokenExpiresAt = now + 15 * 60 * 1000 // 15 minutes

    return {
      accessToken,
      refreshToken: oldToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt: record.expires_at,
    }
  }

  // Mark old token as rotated
  await db
    .prepare(`UPDATE refresh_tokens SET rotated_at = ? WHERE id = ?`)
    .bind(now, record.id)
    .run()

  // Create new refresh token
  const newRefreshToken = await createRefreshToken(db, record.user_id, record.device_id)
  const refreshTokenExpiresAt = now + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000

  // Generate new access token
  const accessToken = await generateAccessToken(record.user_id, record.device_id, jwtSecret)
  const accessTokenExpiresAt = now + 15 * 60 * 1000 // 15 minutes

  return {
    accessToken,
    refreshToken: newRefreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  }
}

/**
 * Revoke all refresh tokens for a specific device.
 * Called when a device is removed from the user's account.
 *
 * @param db - D1 database
 * @param deviceId - Device ID to revoke tokens for
 * @returns Number of tokens revoked
 */
export const revokeDeviceTokens = async (
  db: D1Database,
  deviceId: string
): Promise<number> => {
  const now = Date.now()

  const result = await db
    .prepare(
      `
      UPDATE refresh_tokens
      SET revoked_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `
    )
    .bind(now, deviceId)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Revoke all refresh tokens for a user across all devices.
 * Called for account-wide logout or security events.
 *
 * @param db - D1 database
 * @param userId - User ID to revoke tokens for
 * @returns Number of tokens revoked
 */
export const revokeUserTokens = async (
  db: D1Database,
  userId: string
): Promise<number> => {
  const now = Date.now()

  const result = await db
    .prepare(
      `
      UPDATE refresh_tokens
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `
    )
    .bind(now, userId)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Revoke a specific refresh token.
 *
 * @param db - D1 database
 * @param token - The refresh token to revoke
 * @returns True if token was found and revoked
 */
export const revokeRefreshToken = async (
  db: D1Database,
  token: string
): Promise<boolean> => {
  const tokenHash = await hashToken(token)
  const now = Date.now()

  const result = await db
    .prepare(
      `
      UPDATE refresh_tokens
      SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `
    )
    .bind(now, tokenHash)
    .run()

  return (result.meta.changes ?? 0) > 0
}

/**
 * Clean up expired and old rotated refresh tokens.
 *
 * @param db - D1 database
 * @returns Number of tokens cleaned up
 */
export const cleanupRefreshTokens = async (db: D1Database): Promise<number> => {
  const now = Date.now()
  const rotationCleanupTime = now - REFRESH_TOKEN_GRACE_PERIOD_MS

  // Delete expired tokens and rotated tokens past grace period
  const result = await db
    .prepare(
      `
      DELETE FROM refresh_tokens
      WHERE expires_at < ?
         OR (rotated_at IS NOT NULL AND rotated_at < ?)
    `
    )
    .bind(now, rotationCleanupTime)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Verify a JWT access token and extract payload.
 *
 * @param token - The JWT to verify
 * @param secret - JWT signing secret
 * @returns Decoded payload
 */
export const verifyAccessToken = async (
  token: string,
  secret: string
): Promise<JWTPayload> => {
  const secretKey = new TextEncoder().encode(secret)

  try {
    const { payload } = await jose.jwtVerify(token, secretKey, {
      algorithms: [JWT_ALGORITHM],
    })

    if (!payload.sub || !payload.deviceId) {
      throw new SyncError('Invalid token payload', ErrorCode.AUTH_INVALID_TOKEN, 401)
    }

    return {
      sub: payload.sub,
      deviceId: payload.deviceId as string,
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    }
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      throw new SyncError('Token has expired', ErrorCode.AUTH_TOKEN_EXPIRED, 401)
    }
    if (error instanceof SyncError) {
      throw error
    }
    throw new SyncError('Invalid token', ErrorCode.AUTH_INVALID_TOKEN, 401)
  }
}
