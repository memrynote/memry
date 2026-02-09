import { importSPKI, jwtVerify } from 'jose'
import type { MiddlewareHandler } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import type { AppContext } from '../types'

const REQUIRED_ISSUER = 'memry-sync'
const REQUIRED_AUDIENCE = 'memry-client'
const ALLOWED_ALGORITHM = 'EdDSA'

export const authMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Missing or malformed Authorization header', 401)
  }

  const token = authHeader.slice(7)
  const signingKeyPem = c.env.JWT_SIGNING_KEY

  let publicKey: CryptoKey
  try {
    publicKey = await importSPKI(signingKeyPem, ALLOWED_ALGORITHM)
  } catch {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invalid JWT signing key configuration', 500)
  }

  let payload: { sub?: string; device_id?: string }
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: [ALLOWED_ALGORITHM],
      issuer: REQUIRED_ISSUER,
      audience: REQUIRED_AUDIENCE,
    })
    payload = result.payload as typeof payload
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed'
    if (message.includes('expired')) {
      throw new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 'Token has expired', 401)
    }
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid token', 401)
  }

  const userId = payload.sub
  const deviceId = payload.device_id

  if (!userId || !deviceId) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Token missing required claims', 401)
  }

  const device = await c.env.DB
    .prepare('SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?')
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
