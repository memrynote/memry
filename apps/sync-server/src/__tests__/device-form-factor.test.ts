import { Hono } from 'hono'
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DeviceListResponseSchema } from '@memry/contracts/auth-api'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { errorHandler } from '../lib/errors'
import { auth } from '../routes/auth'
import { devices } from '../routes/devices'
import { signSetupToken } from '../services/auth'
import type { AppContext } from '../types'

/**
 * #4375: an iPad registers as `ios`, like an iPhone, and adds formFactor
 * 'tablet'. This runs the real register and list routes over the real
 * migration ledger, signed with real keys, so the column, the INSERT and the
 * list mapping are the code under test, not a fake that answers what it was told.
 */

const USER_ID = 'user-form-factor'

let harness: SqliteD1
let privatePem: string
let publicPem: string

const app = new Hono<AppContext>()
app.onError(errorHandler)
app.route('/auth', auth)
app.route('/devices', devices)

const rateLimiter = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async () => Response.json({ count: 1, windowStart: Math.floor(Date.now() / 1000) })
  })
}

const send = (path: string, token: string, body?: unknown) =>
  app.request(
    path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    {
      DB: harness.db,
      JWT_PUBLIC_KEY: publicPem,
      JWT_PRIVATE_KEY: privatePem,
      RATE_LIMITER: rateLimiter,
      ENVIRONMENT: 'test'
    },
    { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
  )

const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('base64')

/** A device keypair, kept across registrations the way a client keeps it. */
const deviceKey = async (): Promise<CryptoKeyPair> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Ed25519 generateKey always yields a pair; the DOM lib types it as CryptoKey | CryptoKeyPair
  (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair

/** POST /auth/devices with a fresh setup token, as a client does after sign-in. */
const register = async (key: CryptoKeyPair, extra: Record<string, unknown>) => {
  const setupToken = await signSetupToken(USER_ID, privatePem)
  const jti = String(decodeJwt(setupToken).jti)
  const nonce = crypto.randomUUID()
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key.privateKey,
    new TextEncoder().encode(`${nonce}:${jti}`)
  )
  const publicKey = await crypto.subtle.exportKey('raw', key.publicKey)
  if (!(publicKey instanceof ArrayBuffer)) throw new Error('raw export is bytes')
  const res = await send('/auth/devices', setupToken, {
    name: 'Kaan iPad',
    platform: 'ios',
    appVersion: '1.0.0',
    authPublicKey: toBase64(publicKey),
    challengeSignature: toBase64(signature),
    challengeNonce: nonce,
    ...extra
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { deviceId: string; accessToken: string }
}

const listed = async (accessToken: string) => {
  const res = await send('/devices', accessToken)
  expect(res.status).toBe(200)
  // The contract older and newer readers parse.
  return DeviceListResponseSchema.parse(await res.json()).devices
}

beforeEach(async () => {
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, kdf_salt, key_verifier, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 'salt', 'verifier', 1, 1)`
    )
    .run(USER_ID, `${USER_ID}@example.com`)
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true
  })
  privatePem = await exportPKCS8(privateKey)
  publicPem = await exportSPKI(publicKey)
})

afterEach(() => {
  harness.close()
})

describe('device form factor (#4375)', () => {
  it('stores a tablet on register and lists it', async () => {
    const { accessToken } = await register(await deviceKey(), { formFactor: 'tablet' })

    const [row] = await listed(accessToken)
    expect(row).toMatchObject({ platform: 'ios', formFactor: 'tablet' })
  })

  it('lists a client that sends no form factor as unknown, in the shape older readers parse', async () => {
    const { accessToken } = await register(await deviceKey(), {})

    const [row] = await listed(accessToken)
    expect(row.formFactor).toBeNull()
    // Every field a shipped reader requires keeps its name and type, so the
    // new key is the only difference an older desktop or iOS build sees.
    expect(row).toMatchObject({
      id: expect.any(String),
      name: 'Kaan iPad',
      platform: 'ios',
      appVersion: '1.0.0',
      lastSyncAt: null,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number)
    })
  })

  it('keeps the known form factor when an older build of the same device re-registers', async () => {
    const key = await deviceKey()
    const first = await register(key, { formFactor: 'tablet' })
    const again = await register(key, {})

    expect(again.deviceId).toBe(first.deviceId)
    const [row] = await listed(again.accessToken)
    expect(row.formFactor).toBe('tablet')
  })

  it('registers a newer client whose form factor this server does not know, as unknown', async () => {
    const { accessToken } = await register(await deviceKey(), { formFactor: 'watch' })

    const [row] = await listed(accessToken)
    expect(row.formFactor).toBeNull()
  })
})
