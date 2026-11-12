import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import type * as RateLimitModule from '../middleware/rate-limit'

vi.mock('../middleware/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

import { app } from '../index'
import { IOS_BETA_SEGMENT_ID } from '../services/ios-beta'

const INSTALL_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const EMAIL = 'tester@example.com'

let ascPrivateKey = ''
let ascPublicKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  ascPrivateKey = await exportPKCS8(pair.privateKey)
  ascPublicKey = pair.publicKey
})

const createEnv = (overrides?: Record<string, unknown>) => ({
  DB: {} as D1Database,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: '',
  JWT_PRIVATE_KEY: '',
  RESEND_API_KEY: 'test-resend-key',
  TELEMETRY_HMAC_KEY: 'test-telemetry-hmac-key-0123456789abcdef',
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://posthog.test',
  ASC_KEY_ID: 'KEY123',
  ASC_ISSUER_ID: 'issuer-1',
  ASC_PRIVATE_KEY: ascPrivateKey,
  ASC_BETA_GROUP_ID: 'group-1',
  ...overrides
})

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

let calls: Call[] = []
let respond: (url: string) => Response

const parseBody = (body: BodyInit | null | undefined): unknown =>
  typeof body === 'string' ? JSON.parse(body) : undefined

beforeEach(() => {
  calls = []
  respond = () => Response.json({ id: 'ok' })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: parseBody(init?.body)
    })
    return respond(url)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const join = (body: Record<string, unknown>, env = createEnv()) =>
  app.request(
    new Request('http://localhost/ios-beta/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: EMAIL,
        source: 'settings',
        appVersion: '1.9.0',
        platform: 'darwin',
        ...body
      })
    }),
    {},
    env
  )

const callTo = (prefix: string): Call[] => calls.filter((call) => call.url.startsWith(prefix))

describe('POST /ios-beta/join', () => {
  it('invites the tester, files the contact, and records the install without the email', async () => {
    const res = await join({ installId: INSTALL_ID, source: 'launch_prompt' })
    expect(res.status).toBe(200)

    const [asc] = callTo('https://api.appstoreconnect.apple.com/v1/betaTesters')
    const token = asc.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
    const { payload, protectedHeader } = await jwtVerify(token, ascPublicKey, {
      audience: 'appstoreconnect-v1',
      issuer: 'issuer-1'
    })
    expect(protectedHeader.kid).toBe('KEY123')
    expect(payload.exp).toBeDefined()
    expect(asc.body).toMatchObject({
      data: {
        attributes: { email: EMAIL },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: 'group-1' }] } }
      }
    })

    const resend = callTo('https://api.resend.com/contacts')
    expect(resend.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.resend.com/contacts',
      `POST https://api.resend.com/contacts/${encodeURIComponent(EMAIL)}/segments/${IOS_BETA_SEGMENT_ID}`,
      `PATCH https://api.resend.com/contacts/${encodeURIComponent(EMAIL)}`
    ])
    const properties = (resend[2].body as { properties: Record<string, string> }).properties
    expect(properties.signup_source).toBe('desktop')
    expect(properties.install_hash).toMatch(/^[0-9a-f]{64}$/)

    const [posthog] = callTo('https://posthog.test')
    const event = (posthog.body as { batch: Record<string, unknown>[] }).batch[0]
    expect(event).toMatchObject({
      event: 'ios_beta_joined',
      distinct_id: properties.install_hash,
      properties: { source: 'launch_prompt', $set: { ios_beta_joined: true } }
    })
    expect(JSON.stringify(posthog.body)).not.toContain(EMAIL)
    expect(JSON.stringify(calls)).not.toContain(INSTALL_ID)
  })

  it('skips the install link when telemetry is off (no installId)', async () => {
    const res = await join({})
    expect(res.status).toBe(200)
    expect(callTo('https://posthog.test')).toHaveLength(0)
    const patch = callTo('https://api.resend.com/contacts').find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ properties: { signup_source: 'desktop' } })
  })

  it('fails without touching the list when App Store Connect rejects the tester', async () => {
    respond = (url) =>
      url.startsWith('https://api.appstoreconnect.apple.com')
        ? Response.json({ errors: [{ code: 'ENTITY_ERROR', detail: 'nope' }] }, { status: 409 })
        : Response.json({ id: 'ok' })
    const res = await join({ installId: INSTALL_ID })
    expect(res.status).toBe(502)
    expect(callTo('https://api.resend.com')).toHaveLength(0)
    expect(callTo('https://posthog.test')).toHaveLength(0)
  })

  it('still succeeds once the invite is sent, even if Resend fails', async () => {
    respond = (url) =>
      url.startsWith('https://api.resend.com')
        ? Response.json({ message: 'boom' }, { status: 500 })
        : Response.json({ id: 'ok' })
    const res = await join({ installId: INSTALL_ID })
    expect(res.status).toBe(200)
    expect(callTo('https://posthog.test')).toHaveLength(1)
  })

  it('answers 503 when the TestFlight env is not configured', async () => {
    const res = await join({}, createEnv({ ASC_PRIVATE_KEY: undefined }))
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('rejects an invalid email', async () => {
    const res = await join({ email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
