/**
 * T031: JWT Validation Middleware
 *
 * Validates JWT access tokens and attaches user context to the request.
 */

import type { Context, MiddlewareHandler, Env as HonoEnv } from 'hono'
import { unauthorized, invalidToken } from '../lib/errors'
import { verifyAccessToken, type JWTPayload } from '../services/auth'

/**
 * User context attached to authenticated requests.
 */
export interface AuthContext {
  userId: string
  deviceId: string
  tokenIssuedAt: number
  tokenExpiresAt: number
}

/**
 * Environment type expected for auth middleware.
 */
interface AuthEnv {
  JWT_SECRET: string
}

/**
 * Variables set by auth middleware.
 */
interface AuthVariables {
  auth: AuthContext
}

/**
 * Extract Bearer token from Authorization header.
 *
 * @param c - Hono context
 * @returns Token string or null
 */
const extractBearerToken = <E extends HonoEnv>(c: Context<E>): string | null => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) {
    return null
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/**
 * Create auth middleware that validates JWT tokens.
 *
 * Usage:
 * ```ts
 * app.use('/api/*', authMiddleware())
 * ```
 *
 * After middleware runs, access auth context via:
 * ```ts
 * const { userId, deviceId } = c.get('auth')
 * ```
 */
export const authMiddleware = <
  E extends { Bindings: AuthEnv; Variables: AuthVariables },
>(): MiddlewareHandler<E> => {
  return async (c, next) => {
    const token = extractBearerToken(c)

    if (!token) {
      throw unauthorized('Missing authorization header')
    }

    const jwtSecret = c.env.JWT_SECRET
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not configured')
    }

    const payload = await verifyAccessToken(token, jwtSecret)

    // Attach auth context to request
    const auth: AuthContext = {
      userId: payload.sub,
      deviceId: payload.deviceId,
      tokenIssuedAt: payload.iat * 1000, // Convert to ms
      tokenExpiresAt: payload.exp * 1000, // Convert to ms
    }

    c.set('auth', auth)

    await next()
  }
}

/**
 * Get auth context from request.
 * Throws if not authenticated.
 *
 * @param c - Hono context
 * @returns Auth context
 */
export const getAuth = <E extends { Variables: AuthVariables }>(c: Context<E>): AuthContext => {
  const auth = c.get('auth')
  if (!auth) {
    throw unauthorized('Not authenticated')
  }
  return auth
}

/**
 * Optional auth middleware that doesn't throw on missing token.
 * Useful for endpoints that work both authenticated and unauthenticated.
 */
export const optionalAuthMiddleware = <
  E extends { Bindings: AuthEnv; Variables: Partial<AuthVariables> },
>(): MiddlewareHandler<E> => {
  return async (c, next) => {
    const token = extractBearerToken(c)

    if (token) {
      const jwtSecret = c.env.JWT_SECRET
      if (jwtSecret) {
        try {
          const payload = await verifyAccessToken(token, jwtSecret)

          const auth: AuthContext = {
            userId: payload.sub,
            deviceId: payload.deviceId,
            tokenIssuedAt: payload.iat * 1000,
            tokenExpiresAt: payload.exp * 1000,
          }

          // Use type assertion since we're in partial variables mode
          ;(c as unknown as Context<{ Variables: AuthVariables }>).set('auth', auth)
        } catch {
          // Invalid token - continue without auth
        }
      }
    }

    await next()
  }
}

/**
 * Get optional auth context from request.
 * Returns null if not authenticated.
 *
 * @param c - Hono context
 * @returns Auth context or null
 */
export const getOptionalAuth = <E extends { Variables: Partial<AuthVariables> }>(
  c: Context<E>
): AuthContext | null => {
  return (c.get('auth') as AuthContext | undefined) ?? null
}

/**
 * Require specific device ID in addition to authentication.
 * Useful for device-specific operations.
 *
 * @param requiredDeviceId - Device ID to require
 */
export const requireDevice = <E extends { Variables: AuthVariables }>(
  c: Context<E>,
  requiredDeviceId: string
): void => {
  const auth = getAuth(c)
  if (auth.deviceId !== requiredDeviceId) {
    throw invalidToken('Token device ID does not match required device')
  }
}
