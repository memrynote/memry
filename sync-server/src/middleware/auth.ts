/**
 * JWT Authentication Middleware
 *
 * Validates JWT access tokens for protected API routes.
 * Tokens are issued during login/signup and contain user/device info.
 *
 * @module middleware/auth
 */

import { createMiddleware } from 'hono/factory'
import * as jose from 'jose'
import type { Env } from '../index'
import { AuthenticationError, AuthorizationError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/**
 * JWT payload structure
 */
export interface JwtPayload {
  /** User ID */
  sub: string
  /** Device ID */
  did: string
  /** Email */
  email: string
  /** Token type */
  type: 'access' | 'refresh'
  /** Issued at (Unix timestamp) */
  iat: number
  /** Expiration (Unix timestamp) */
  exp: number
}

/**
 * Authenticated user context
 */
export interface AuthContext {
  userId: string
  deviceId: string
  email: string
}

// =============================================================================
// JWT Configuration
// =============================================================================

/** Access token expiration (15 minutes) */
export const ACCESS_TOKEN_EXPIRY = '15m'

/** Refresh token expiration (30 days) */
export const REFRESH_TOKEN_EXPIRY = '30d'

// =============================================================================
// Token Creation
// =============================================================================

/**
 * Create a JWT access token.
 *
 * @param payload - Token payload
 * @param secret - JWT secret
 * @returns Signed JWT token
 */
export async function createAccessToken(
  payload: { userId: string; deviceId: string; email: string },
  secret: string
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret)

  return new jose.SignJWT({
    sub: payload.userId,
    did: payload.deviceId,
    email: payload.email,
    type: 'access'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(secretKey)
}

/**
 * Create a JWT refresh token.
 *
 * @param payload - Token payload
 * @param secret - JWT secret
 * @returns Signed JWT token
 */
export async function createRefreshToken(
  payload: { userId: string; deviceId: string; email: string },
  secret: string
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret)

  return new jose.SignJWT({
    sub: payload.userId,
    did: payload.deviceId,
    email: payload.email,
    type: 'refresh'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .sign(secretKey)
}

/**
 * Create both access and refresh tokens.
 *
 * @param payload - Token payload
 * @param secret - JWT secret
 * @returns Access and refresh tokens
 */
export async function createTokenPair(
  payload: { userId: string; deviceId: string; email: string },
  secret: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(payload, secret),
    createRefreshToken(payload, secret)
  ])

  return { accessToken, refreshToken }
}

// =============================================================================
// Token Verification
// =============================================================================

/**
 * Verify and decode a JWT token.
 *
 * @param token - JWT token
 * @param secret - JWT secret
 * @returns Decoded payload
 * @throws AuthenticationError if token is invalid
 */
export async function verifyToken(token: string, secret: string): Promise<JwtPayload> {
  const secretKey = new TextEncoder().encode(secret)

  try {
    const { payload } = await jose.jwtVerify(token, secretKey)

    return {
      sub: payload.sub as string,
      did: payload.did as string,
      email: payload.email as string,
      type: payload.type as 'access' | 'refresh',
      iat: payload.iat as number,
      exp: payload.exp as number
    }
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      throw new AuthenticationError('Token expired')
    }
    if (error instanceof jose.errors.JWTInvalid) {
      throw new AuthenticationError('Invalid token')
    }
    throw new AuthenticationError('Token verification failed')
  }
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Authentication middleware for protected routes.
 *
 * Extracts and validates the JWT from the Authorization header.
 * Sets the user context for downstream handlers.
 *
 * Usage:
 * ```typescript
 * app.use('/api/*', authMiddleware)
 * ```
 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: { user: AuthContext } }>(
  async (c, next) => {
    // Extract token from Authorization header
    const authHeader = c.req.header('Authorization')

    if (!authHeader) {
      throw new AuthenticationError('Authorization header required')
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Invalid authorization format. Use: Bearer <token>')
    }

    const token = authHeader.slice(7) // Remove 'Bearer '

    if (!token) {
      throw new AuthenticationError('Token required')
    }

    // Get JWT secret from environment
    const secret = c.env.JWT_SECRET

    if (!secret) {
      console.error('JWT_SECRET not configured')
      throw new AuthenticationError('Server configuration error')
    }

    // Verify token
    const payload = await verifyToken(token, secret)

    // Ensure it's an access token
    if (payload.type !== 'access') {
      throw new AuthenticationError('Invalid token type')
    }

    // Set user context
    c.set('user', {
      userId: payload.sub,
      deviceId: payload.did,
      email: payload.email
    })

    await next()
  }
)

/**
 * Optional authentication middleware.
 *
 * Sets user context if valid token is provided, but doesn't fail
 * if no token is present.
 */
export const optionalAuthMiddleware = createMiddleware<{
  Bindings: Env
  Variables: { user?: AuthContext }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await next()
    return
  }

  const token = authHeader.slice(7)
  const secret = c.env.JWT_SECRET

  if (!token || !secret) {
    await next()
    return
  }

  try {
    const payload = await verifyToken(token, secret)

    if (payload.type === 'access') {
      c.set('user', {
        userId: payload.sub,
        deviceId: payload.did,
        email: payload.email
      })
    }
  } catch {
    // Ignore auth errors for optional auth
  }

  await next()
})

/**
 * Device authorization middleware.
 *
 * Ensures the authenticated device matches the requested device ID.
 * Use after authMiddleware for device-specific routes.
 *
 * @param deviceIdParam - Name of the route parameter containing device ID
 */
export function requireDevice(deviceIdParam: string = 'deviceId') {
  return createMiddleware<{ Bindings: Env; Variables: { user: AuthContext } }>(async (c, next) => {
    const user = c.get('user')
    const requestedDeviceId = c.req.param(deviceIdParam)

    if (requestedDeviceId && requestedDeviceId !== user.deviceId) {
      throw new AuthorizationError('Device not authorized')
    }

    await next()
  })
}
