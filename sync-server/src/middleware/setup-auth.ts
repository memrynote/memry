import { jwtVerify } from 'jose'
import type { MiddlewareHandler } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { getPublicKey } from '../lib/jwt-keys'
import type { AppContext } from '../types'

const REQUIRED_ISSUER = 'memry-sync'
const REQUIRED_AUDIENCE = 'memry-client'
const ALLOWED_ALGORITHM = 'EdDSA'

export const setupAuthMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(
      ErrorCodes.AUTH_INVALID_TOKEN,
      'Missing or malformed Authorization header',
      401
    )
  }

  const token = authHeader.slice(7)

  let publicKey: CryptoKey
  try {
    publicKey = await getPublicKey(c.env.JWT_PUBLIC_KEY)
  } catch {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invalid JWT verify key configuration', 500)
  }

  let payload: { sub?: string; type?: string; jti?: string; session_nonce?: string }
  try {
    const result = await jwtVerify(token, publicKey, {
      algorithms: [ALLOWED_ALGORITHM],
      issuer: REQUIRED_ISSUER,
      audience: REQUIRED_AUDIENCE
    })
    payload = result.payload as typeof payload
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed'
    if (message.includes('expired')) {
      throw new AppError(ErrorCodes.AUTH_TOKEN_EXPIRED, 'Setup token has expired', 401)
    }
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid setup token', 401)
  }

  if (payload.type !== 'setup') {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid token type', 401)
  }

  if (!payload.sub) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Token missing required claims', 401)
  }

  if (!payload.jti) {
    throw new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Token missing jti claim', 401)
  }

  c.set('userId', payload.sub)
  c.set('tokenJti', payload.jti)
  if (payload.session_nonce) {
    c.set('sessionNonce', payload.session_nonce)
  }

  await next()
}
