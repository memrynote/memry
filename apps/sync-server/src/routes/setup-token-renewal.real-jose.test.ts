import { Hono } from 'hono'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

/**
 * Deliberately NO `vi.mock('jose')` and NO `vi.mock('../services/auth')`.
 *
 * `auth.test.ts` stubs both, so a renewal test living there would assert our
 * mocks agreed with each other — the exact false confidence that let #1202 sit
 * in production. Here the setup token is signed by the real signer, expired by
 * moving the clock, and renewed through the real route with a real Ed25519
 * device signature.
 */

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next()
}))

vi.mock('../services/analytics', () => ({
  captureBusinessEvent: vi.fn().mockResolvedValue(undefined),
  captureServerError: vi.fn().mockResolvedValue(undefined),
  safeWaitUntil: vi.fn(),
  waitUntilCaptured: vi.fn()
}))

vi.mock('../services/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined)
}))

import { auth } from './auth'
import { setupAuthMiddleware } from '../middleware/setup-auth'
import { SETUP_TOKEN_RENEWAL_WINDOW_SECONDS, signSetupToken } from '../services/auth'

const ALGORITHM = 'EdDSA'
const SIGN_IN_AT_MS = Date.UTC(2026, 7, 13, 9, 0, 0)

interface DeviceKeys {
  publicKeyBase64: string
  privateKey: CryptoKey
}

const toBase64 = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))

const createDeviceKeys = async (): Promise<DeviceKeys> => {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, {
    crv: 'Ed25519',
    extractable: true
  })
  return {
    publicKeyBase64: toBase64((await crypto.subtle.exportKey('raw', publicKey)) as ArrayBuffer),
    privateKey
  }
}

const signChallenge = async (
  device: DeviceKeys,
  challengeNonce: string,
  jti: string
): Promise<string> =>
  toBase64(
    await crypto.subtle.sign(
      'Ed25519',
      device.privateKey,
      new TextEncoder().encode(`${challengeNonce}:${jti}`)
    )
  )

const decodeJti = (token: string): string =>
  JSON.parse(atob(token.split('.')[1]!)).jti as string

/** Records every consumed_setup_tokens insert so single-use can be asserted. */
const createEnv = (
  jwtPrivateKey: string,
  jwtPublicKey: string,
  options?: { alreadyConsumed?: boolean }
) => {
  const consumedJtis: string[] = []

  const statement = {
    bind: vi.fn((...args: unknown[]) => {
      consumedJtis.push(String(args[0]))
      return statement
    }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: options?.alreadyConsumed ? 0 : 1 }
    }),
    all: vi.fn().mockResolvedValue({ results: [] })
  }

  return {
    env: {
      DB: { prepare: vi.fn().mockReturnValue(statement), batch: vi.fn() },
      JWT_PRIVATE_KEY: jwtPrivateKey,
      JWT_PUBLIC_KEY: jwtPublicKey,
      ENVIRONMENT: 'test'
    } as unknown as Record<string, unknown>,
    consumedJtis
  }
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

describe('POST /auth/setup-token/renew against real jose', () => {
  let app: Hono<AppContext>
  let jwtPrivateKey: string
  let jwtPublicKey: string
  let device: DeviceKeys

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SIGN_IN_AT_MS)

    const keys = await generateKeyPair(ALGORITHM, { crv: 'Ed25519', extractable: true })
    jwtPrivateKey = await exportPKCS8(keys.privateKey)
    jwtPublicKey = await exportSPKI(keys.publicKey)
    device = await createDeviceKeys()

    app = new Hono<AppContext>()
    app.onError(errorHandler)
    app.route('/auth', auth)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Sign in, then walk away for `minutes` looking for the recovery phrase. */
  const signInThenWait = async (
    minutes: number,
    binding: { devicePublicKey?: string } = { devicePublicKey: device.publicKeyBase64 }
  ): Promise<string> => {
    const token = await signSetupToken('user-1', jwtPrivateKey, undefined, binding)
    vi.setSystemTime(SIGN_IN_AT_MS + minutes * 60_000)
    return token
  }

  it('renews a setup token that ran out while the user hunted for their phrase', async () => {
    // #given the #1202 reinstall: the token was minted at sign-in and is stone
    // dead 20 minutes later, when the user finally types their 24 words.
    const expired = await signInThenWait(20)
    const { env, consumedJtis } = createEnv(jwtPrivateKey, jwtPublicKey)
    const challengeNonce = 'nonce-1'

    // #when the device proves possession of the key it committed at sign-in.
    const res = await app.request(
      '/auth/setup-token/renew',
      jsonPost({
        setupToken: expired,
        challengeNonce,
        challengeSignature: await signChallenge(device, challengeNonce, decodeJti(expired))
      }),
      env
    )

    // #then it gets a live token back...
    expect(res.status).toBe(200)
    const { success, setupToken } = (await res.json()) as {
      success: boolean
      setupToken: string
    }
    expect(success).toBe(true)

    // ...that the real setup-auth middleware admits,
    const setMap = new Map<string, string>()
    await setupAuthMiddleware(
      {
        req: { header: () => `Bearer ${setupToken}` },
        env: { JWT_PUBLIC_KEY: jwtPublicKey },
        set: (key: string, value: string) => setMap.set(key, value)
      } as never,
      vi.fn(async () => undefined)
    )
    expect(setMap.get('userId')).toBe('user-1')

    // ...while the presented grant is retired, so only one is ever redeemable.
    expect(consumedJtis).toContain(decodeJti(expired))
    expect(decodeJti(setupToken)).not.toBe(decodeJti(expired))
  })

  it('refuses a renewal signed by a device key that was never committed', async () => {
    // #given a setup token lifted from a log or an intercepted response — the
    // attacker has the bearer token but not the device's private key.
    const expired = await signInThenWait(20)
    const attacker = await createDeviceKeys()
    const { env, consumedJtis } = createEnv(jwtPrivateKey, jwtPublicKey)
    const challengeNonce = 'nonce-2'

    // #when
    const res = await app.request(
      '/auth/setup-token/renew',
      jsonPost({
        setupToken: expired,
        challengeNonce,
        challengeSignature: await signChallenge(attacker, challengeNonce, decodeJti(expired))
      }),
      env
    )

    // #then bearer possession alone buys nothing, and the grant is left intact
    // for its real owner.
    expect(res.status).toBe(401)
    expect(consumedJtis).toHaveLength(0)
  })

  it('refuses to renew a setup token that committed no device key', async () => {
    // #given a token minted for a client that predates the commitment (or could
    // not produce a key) — it keeps exactly the old, non-renewable behaviour.
    const expired = await signInThenWait(20, {})
    const { env } = createEnv(jwtPrivateKey, jwtPublicKey)

    // #when
    const res = await app.request(
      '/auth/setup-token/renew',
      jsonPost({
        setupToken: expired,
        challengeNonce: 'nonce-3',
        challengeSignature: await signChallenge(device, 'nonce-3', decodeJti(expired))
      }),
      env
    )

    // #then
    expect(res.status).toBe(401)
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { message: 'Setup token is not renewable' }
    })
  })

  it('stops renewing once the grant window closes', async () => {
    // #given the renewal window is an absolute bound signed into the grant, so
    // the chain cannot outlive it however many times it was renewed.
    const expired = await signInThenWait(SETUP_TOKEN_RENEWAL_WINDOW_SECONDS / 60 + 1)
    const { env, consumedJtis } = createEnv(jwtPrivateKey, jwtPublicKey)

    // #when
    const res = await app.request(
      '/auth/setup-token/renew',
      jsonPost({
        setupToken: expired,
        challengeNonce: 'nonce-4',
        challengeSignature: await signChallenge(device, 'nonce-4', decodeJti(expired))
      }),
      env
    )

    // #then
    expect(res.status).toBe(401)
    expect(consumedJtis).toHaveLength(0)
  })

  it('refuses a grant that was already spent', async () => {
    // #given the jti is already in consumed_setup_tokens — it either registered
    // a device or was renewed away. Either way it must not mint a second token.
    const expired = await signInThenWait(20)
    const { env } = createEnv(jwtPrivateKey, jwtPublicKey, { alreadyConsumed: true })

    // #when
    const res = await app.request(
      '/auth/setup-token/renew',
      jsonPost({
        setupToken: expired,
        challengeNonce: 'nonce-5',
        challengeSignature: await signChallenge(device, 'nonce-5', decodeJti(expired))
      }),
      env
    )

    // #then
    expect(res.status).toBe(401)
    expect((await res.json()) as { error?: { message?: string } }).toMatchObject({
      error: { message: 'Setup token already used' }
    })
  })
})
