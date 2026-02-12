import { jwtVerify } from 'jose'

import { getPublicKey } from './jwt-keys'

const REQUIRED_ISSUER = 'memry-sync'
const REQUIRED_AUDIENCE = 'memry-client'
const ALLOWED_ALGORITHM = 'EdDSA'

export class JwtKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtKeyError'
  }
}

export interface JwtClaims {
  userId: string
  deviceId: string
  exp: number
}

export async function verifyAccessToken(token: string, publicKeyPem: string): Promise<JwtClaims> {
  let publicKey: CryptoKey
  try {
    publicKey = await getPublicKey(publicKeyPem)
  } catch (err) {
    throw new JwtKeyError(err instanceof Error ? err.message : 'Invalid key configuration')
  }

  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: [ALLOWED_ALGORITHM],
    issuer: REQUIRED_ISSUER,
    audience: REQUIRED_AUDIENCE
  })

  if (payload.type !== 'access') {
    throw new Error('Invalid token type')
  }

  const userId = payload.sub
  const deviceId = payload.device_id as string | undefined

  if (!userId || !deviceId) {
    throw new Error('Token missing required claims')
  }

  return { userId, deviceId, exp: payload.exp! }
}
