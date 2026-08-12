import { describe, expect, it, vi } from 'vitest'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'

import { AppError, ErrorCodes } from '../lib/errors'
import { setupAuthMiddleware } from './setup-auth'

/**
 * Deliberately NO `vi.mock('jose')` in this file.
 *
 * The sibling suite (`setup-auth.test.ts`) stubs the whole module and hand-builds
 * `Object.assign(new Error(...), { code: 'ERR_JWT_EXPIRED' })`. That asserts our
 * assumption about jose, never jose itself — so the mapping could drift with a
 * jose upgrade and every test would stay green while expired setup tokens were
 * once again reported to users as "Invalid setup token" (issue #1202).
 *
 * Here a genuinely expired token is signed with the real jose (^6.1.3) and driven
 * through the real middleware. This is the test that would have caught the
 * original bug.
 */

const ISSUER = 'memry-sync'
const AUDIENCE = 'memry-client'
const ALGORITHM = 'EdDSA'

async function mintSetupToken(expiresAtEpochSeconds: number): Promise<{
  token: string
  publicKeyPem: string
}> {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { crv: 'Ed25519' })

  const token = await new SignJWT({ sub: 'user-1', type: 'setup', jti: 'setup-jti-1' })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresAtEpochSeconds)
    .sign(privateKey)

  return { token, publicKeyPem: await exportSPKI(publicKey) }
}

function createContext(token: string, publicKeyPem: string) {
  const setMap = new Map<string, string>()

  const context = {
    req: {
      header: vi.fn((name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined))
    },
    env: { JWT_PUBLIC_KEY: publicKeyPem },
    set: vi.fn((key: string, value: string) => {
      setMap.set(key, value)
    })
  }

  return { context, setMap }
}

describe('setup-auth middleware against real jose', () => {
  it('maps a genuinely expired setup token to AUTH_TOKEN_EXPIRED', async () => {
    // #given a real setup token whose exp lapsed a minute ago — the reinstall
    // case, where the five-minute token runs out while the user hunts for their
    // 24-word recovery phrase.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const { token, publicKeyPem } = await mintSetupToken(nowSeconds - 60)
    const { context } = createContext(token, publicKeyPem)

    // #when / #then the user is told their session timed out, not that the
    // token was invalid.
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_TOKEN_EXPIRED,
      message: 'Setup token has expired',
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('admits a real setup token that has not expired', async () => {
    // #given the same real signing path, still within its lifetime. Without this
    // control the assertion above could pass for the wrong reason.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const { token, publicKeyPem } = await mintSetupToken(nowSeconds + 300)
    const { context, setMap } = createContext(token, publicKeyPem)
    const next = vi.fn(async () => undefined)

    // #when
    await setupAuthMiddleware(context as never, next)

    // #then
    expect(next).toHaveBeenCalledTimes(1)
    expect(setMap.get('userId')).toBe('user-1')
    expect(setMap.get('tokenJti')).toBe('setup-jti-1')
  })
})
