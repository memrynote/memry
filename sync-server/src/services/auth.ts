/**
 * Auth Service
 *
 * Handles JWT token generation and management.
 * Leverages the auth middleware for token creation and verification.
 *
 * @module services/auth
 */

import { createTokenPair, verifyToken, type JwtPayload } from '../middleware/auth'
import type { User } from './user'
import { AuthenticationError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/**
 * Device info for token generation
 */
export interface DeviceInfo {
  id: string
  name: string
  platform: string
  appVersion: string
}

/**
 * Token pair response
 */
export interface TokenPairResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number // seconds until access token expires
}

/**
 * Auth result returned to client
 */
export interface AuthResult {
  user: {
    id: string
    email: string
    emailVerified: boolean
    authMethod: 'email' | 'oauth'
    authProvider?: 'google'
    storageUsed: number
    storageLimit: number
    createdAt: string
  }
  tokens: TokenPairResponse
  isNewUser: boolean
}

// =============================================================================
// Token Service
// =============================================================================

/** Access token expiry in seconds (15 minutes) */
const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60

/**
 * Generate access and refresh token pair for a user.
 *
 * @param user - User record
 * @param deviceId - Device ID for the tokens
 * @param jwtSecret - JWT signing secret
 * @returns Token pair with expiry
 */
export async function generateTokens(
  user: User,
  deviceId: string,
  jwtSecret: string
): Promise<TokenPairResponse> {
  const { accessToken, refreshToken } = await createTokenPair(
    {
      userId: user.id,
      deviceId,
      email: user.email
    },
    jwtSecret
  )

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS
  }
}

/**
 * Refresh an access token using a refresh token.
 *
 * @param refreshToken - Refresh token
 * @param jwtSecret - JWT signing secret
 * @returns New token pair
 * @throws AuthenticationError if refresh token is invalid
 */
export async function refreshAccessToken(
  refreshToken: string,
  jwtSecret: string
): Promise<{ accessToken: string; expiresIn: number; payload: JwtPayload }> {
  // Verify the refresh token
  const payload = await verifyToken(refreshToken, jwtSecret)

  // Ensure it's a refresh token
  if (payload.type !== 'refresh') {
    throw new AuthenticationError('Invalid token type')
  }

  // Create new access token (refresh token remains valid)
  const { accessToken } = await createTokenPair(
    {
      userId: payload.sub,
      deviceId: payload.did,
      email: payload.email
    },
    jwtSecret
  )

  return {
    accessToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    payload
  }
}

/**
 * Validate a refresh token and return its payload.
 *
 * @param token - Refresh token
 * @param jwtSecret - JWT signing secret
 * @returns Token payload
 * @throws AuthenticationError if token is invalid
 */
export async function validateRefreshToken(token: string, jwtSecret: string): Promise<JwtPayload> {
  const payload = await verifyToken(token, jwtSecret)

  if (payload.type !== 'refresh') {
    throw new AuthenticationError('Invalid token type')
  }

  return payload
}

/**
 * Create full auth result for client response.
 *
 * @param user - User record
 * @param deviceId - Device ID
 * @param jwtSecret - JWT signing secret
 * @param isNewUser - Whether this is a new user
 * @returns Auth result
 */
export async function createAuthResult(
  user: User,
  deviceId: string,
  jwtSecret: string,
  isNewUser: boolean = false
): Promise<AuthResult> {
  const tokens = await generateTokens(user, deviceId, jwtSecret)

  return {
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.email_verified === 1,
      authMethod: user.auth_method as 'email' | 'oauth',
      authProvider: user.auth_provider as 'google' | undefined,
      storageUsed: user.storage_used,
      storageLimit: user.storage_limit,
      createdAt: new Date(user.created_at).toISOString()
    },
    tokens,
    isNewUser
  }
}
