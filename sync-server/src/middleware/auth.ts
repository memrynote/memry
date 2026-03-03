import type { MiddlewareHandler } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { JwtKeyError, verifyAccessToken } from '../lib/jwt-verify'
import type { AppContext } from '../types'

export const authMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_TOKEN,
      'Missing or malformed Authorization header',
      401
    )
  }

  const token = authHeader.slice(7)

  let userId: string
  let deviceId: string
  try {
    const claims = await verifyAccessToken(token, c.env.JWT_PUBLIC_KEY)
    userId = claims.userId
    deviceId = claims.deviceId
  } catch (err) {
    if (err instanceof JwtKeyError) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invalid JWT verify key configuration', 500)
    }
    const message = err instanceof Error ? err.message : 'Token verification failed'
    if (message.includes('expired')) {
      throw new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 'Token has expired', 401)
    }
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, message, 401)
  }

  const device = await c.env.DB.prepare(
    'SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?'
  )
    .bind(deviceId, userId)
    .first<{ id: string; revoked_at: string | null }>()

  if (!device) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_NOT_FOUND, 'Device not registered', 401)
  }

  if (device.revoked_at) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_REVOKED, 'Device has been revoked', 403)
  }

  c.set('userId', userId)
  c.set('deviceId', deviceId)

  await next()
}
