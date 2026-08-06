// End-to-end identity tests for the telemetry/diagnostics routes: a REAL
// Ed25519 keypair and a REAL signed access token, so nothing about the
// verify → hash → distinct_id path is mocked away.
//
// The load-bearing assertion is `expectNoRawAccountId`: the raw account id must
// not appear anywhere in the bytes sent to PostHog. $identify merges are
// permanent and cannot be re-keyed, so a leak here is unrecoverable.
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

import { app } from '../index'
import { hashTelemetryId } from '../services/telemetry'

const ACCOUNT_ID = '99999999-9999-4999-8999-999999999999'
const INSTALL_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const HMAC_KEY = 'test-hmac-key'

let publicKeyPem: string
let privateKeyPem: string

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  publicKeyPem = await exportSPKI(publicKey)
  privateKeyPem = await exportPKCS8(privateKey)
})

const signAccessToken = async (
  overrides: { userId?: string; expiresIn?: string; type?: string } = {}
): Promise<string> =>
  new SignJWT({ device_id: 'device-1', type: overrides.type ?? 'access' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(overrides.userId ?? ACCOUNT_ID)
    .setIssuer('memry-sync')
    .setAudience('memry-client')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '15m')
    .sign(await importPKCS8(privateKeyPem, 'EdDSA'))

// D1 double for the once-per-session $identify guard. `changes: 1` on the first
// INSERT for a key, `0` afterwards — the real ON CONFLICT DO NOTHING semantics.
const createDb = () => {
  const claimed = new Set<string>()
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (!sql.includes('telemetry_identify_sessions')) return { meta: { changes: 0 } }
          const key = String(args[0])
          const isNew = !claimed.has(key)
          claimed.add(key)
          return { meta: { changes: isNew ? 1 : 0 } }
        }
      })
    })
  } as unknown as D1Database
  return { db, claimed }
}

const createEnv = (db: D1Database, overrides?: Record<string, unknown>) => ({
  DB: db,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  TELEMETRY_HMAC_KEY: HMAC_KEY,
  // 'development' so the app's required-secret guard warns instead of throwing
  // for the unrelated secrets this path never touches (RESEND_API_KEY etc.).
  ENVIRONMENT: 'development',
  ALLOWED_ORIGIN: 'https://app.memry.test',
  JWT_PUBLIC_KEY: publicKeyPem,
  // The app's startup secret guard requires this to be present once
  // JWT_PUBLIC_KEY is; the telemetry path never signs anything.
  JWT_PRIVATE_KEY: privateKeyPem,
  RESEND_API_KEY: '',
  OTP_HMAC_KEY: '',
  RECOVERY_DUMMY_SECRET: '',
  WEBHOOK_HMAC_KEY: '',
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ...overrides
})

const batchBody = (sessionId = SESSION_ID) => ({
  schemaVersion: 1,
  installId: INSTALL_ID,
  sessionId,
  appVersion: '2026.7.1',
  buildChannel: 'production',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'tr-TR',
  timezoneOffsetMinutes: 180,
  authState: 'signed_in',
  syncState: 'enabled',
  events: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'note_created',
      occurredAt: '2026-07-22T10:00:00.000Z',
      surface: 'notes',
      action: 'create'
    }
  ]
})

const postBatch = (env: ReturnType<typeof createEnv>, bearer?: string, sessionId?: string) =>
  app.request(
    new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      },
      body: JSON.stringify(batchBody(sessionId))
    }),
    {},
    env
  )

/** Every byte sent to any PostHog endpoint during the test, concatenated. */
const sentBytes = (fetchSpy: ReturnType<typeof vi.fn>): string =>
  fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body)).join('\n')

const expectNoRawAccountId = (fetchSpy: ReturnType<typeof vi.fn>): void => {
  expect(sentBytes(fetchSpy)).not.toContain(ACCOUNT_ID)
}

const captureEvents = (fetchSpy: ReturnType<typeof vi.fn>) => {
  const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
  expect(call).toBeDefined()
  return JSON.parse((call?.[1] as RequestInit).body as string).batch as Array<{
    event: string
    distinct_id: string
    properties: Record<string, unknown>
  }>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /telemetry/batch — account identity', () => {
  it('resolves a verified bearer to the HASHED account id, never the raw id', async () => {
    // #given PostHog configured and a valid access token for a known account
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()
    const token = await signAccessToken()

    // #when posting an authenticated batch
    const response = await postBatch(createEnv(db), token)

    // #then every distinct_id is the HMAC of the account id...
    expect(response.status).toBe(202)
    const expectedHash = await hashTelemetryId(HMAC_KEY, ACCOUNT_ID)
    const events = captureEvents(fetchSpy)
    for (const event of events) expect(event.distinct_id).toBe(expectedHash)

    // #and the raw account id appears nowhere in the payload. This is the
    // regression guard for the one-way door — a $identify merge onto a raw
    // account id is permanent and irreversible.
    expectNoRawAccountId(fetchSpy)
  })

  it('emits $identify aliasing the install hash onto the account hash', async () => {
    // #given an authenticated batch
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()

    // #when posting
    await postBatch(createEnv(db), await signAccessToken())

    // #then $identify merges the anonymous install person into the account person
    const identify = captureEvents(fetchSpy).find((e) => e.event === '$identify')
    expect(identify).toBeDefined()
    expect(identify?.distinct_id).toBe(await hashTelemetryId(HMAC_KEY, ACCOUNT_ID))
    expect(identify?.properties.$anon_distinct_id).toBe(await hashTelemetryId(HMAC_KEY, INSTALL_ID))
    expectNoRawAccountId(fetchSpy)
  })

  it('emits $identify only once per session, not on every 30s batch', async () => {
    // #given three authenticated batches from the same session
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()
    const env = createEnv(db)
    const token = await signAccessToken()

    // #when posting them in turn
    await postBatch(env, token)
    await postBatch(env, token)
    await postBatch(env, token)

    // #then the permanent merge fires exactly once
    const identifyCount = fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith('/batch/'))
      .flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).batch)
      .filter((e: { event: string }) => e.event === '$identify').length
    expect(identifyCount).toBe(1)
  })

  it('re-identifies for a new session id', async () => {
    // #given two batches from DIFFERENT sessions on the same account
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db, claimed } = createDb()
    const env = createEnv(db)
    const token = await signAccessToken()

    // #when posting both
    await postBatch(env, token, SESSION_ID)
    await postBatch(env, token, '44444444-4444-4444-8444-444444444444')

    // #then the guard is keyed per session, so each claims its own row
    expect(claimed.size).toBe(2)
  })

  it('falls back to the install hash when the bearer is invalid', async () => {
    // #given a garbage bearer
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()

    // #when posting
    const response = await postBatch(createEnv(db), 'not-a-jwt')

    // #then telemetry is never rejected for auth reasons; it reports anonymously
    expect(response.status).toBe(202)
    const events = captureEvents(fetchSpy)
    const installHash = await hashTelemetryId(HMAC_KEY, INSTALL_ID)
    for (const event of events) expect(event.distinct_id).toBe(installHash)
    expect(events.some((e) => e.event === '$identify')).toBe(false)
  })

  it('falls back to the install hash when the token is expired', async () => {
    // #given a token that expired an hour ago
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()
    const expired = await signAccessToken({ expiresIn: '-1h' })

    // #when posting
    const response = await postBatch(createEnv(db), expired)

    // #then it still 202s, anonymously
    expect(response.status).toBe(202)
    const installHash = await hashTelemetryId(HMAC_KEY, INSTALL_ID)
    for (const event of captureEvents(fetchSpy)) expect(event.distinct_id).toBe(installHash)
  })

  it('rejects a refresh token as an identity source', async () => {
    // #given a correctly signed token whose type is not "access"
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()
    const refresh = await signAccessToken({ type: 'refresh' })

    // #when posting
    await postBatch(createEnv(db), refresh)

    // #then identity does not resolve
    const installHash = await hashTelemetryId(HMAC_KEY, INSTALL_ID)
    for (const event of captureEvents(fetchSpy)) expect(event.distinct_id).toBe(installHash)
  })
})

describe('POST /diagnostics/report — account identity', () => {
  const reportBody = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    installId: INSTALL_ID,
    sessionId: SESSION_ID,
    appVersion: '2026.7.1',
    buildChannel: 'production',
    platform: 'darwin',
    arch: 'arm64',
    incidentId: 'MEMRY-ABCD2345',
    trigger: { source: 'user_report' },
    snapshot: {
      appVersion: '2026.7.1',
      buildChannel: 'production',
      platform: 'darwin',
      arch: 'arm64',
      locale: 'tr-TR',
      uptimeSeconds: 120,
      syncEnabled: true,
      syncState: 'enabled',
      queueDepth: 0,
      vaultOpen: true,
      authState: 'signed_in'
    },
    lines: [],
    ...overrides
  })

  const postReport = (env: ReturnType<typeof createEnv>, bearer?: string, body = reportBody()) =>
    app.request(
      new Request('http://localhost/diagnostics/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
        },
        body: JSON.stringify(body)
      }),
      {},
      env
    )

  const reportDistinctId = async (fetchSpy: ReturnType<typeof vi.fn>): Promise<string> => {
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/v1/logs'))).toBe(true)
    )
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    const record = JSON.parse((call?.[1] as RequestInit).body as string).resourceLogs[0]
      .scopeLogs[0].logRecords[0]
    const attribute = record.attributes.find((a: { key: string }) => a.key === 'posthogDistinctId')
    return attribute.value.stringValue
  }

  it('lands the report on the same person profile as the events', async () => {
    // #given an authenticated incident report
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()

    // #when posting with a valid bearer
    const response = await postReport(createEnv(db), await signAccessToken())

    // #then the log records carry the resolved (hashed) account distinct id,
    // not the bare install hash — otherwise a report would split off onto a
    // second profile the moment account identity is populated.
    expect(response.status).toBe(202)
    expect(await reportDistinctId(fetchSpy)).toBe(await hashTelemetryId(HMAC_KEY, ACCOUNT_ID))
    expectNoRawAccountId(fetchSpy)
  })

  it('falls back to the install hash without a bearer', async () => {
    // #given an anonymous incident report
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()

    // #when posting with no Authorization header
    const response = await postReport(createEnv(db))

    // #then it resolves to the install hash
    expect(response.status).toBe(202)
    expect(await reportDistinctId(fetchSpy)).toBe(await hashTelemetryId(HMAC_KEY, INSTALL_ID))
  })

  it('ignores a client-asserted accountId in the body', async () => {
    // #given a report body claiming to belong to another account, with no bearer
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { db } = createDb()
    const spoofed = '77777777-7777-4777-8777-777777777777'

    // #when posting
    const response = await postReport(createEnv(db), undefined, reportBody({ accountId: spoofed }))

    // #then identity stays anonymous — a body field must never steer a PostHog
    // person profile, because the merge it would feed is permanent.
    expect(response.status).toBe(202)
    expect(await reportDistinctId(fetchSpy)).toBe(await hashTelemetryId(HMAC_KEY, INSTALL_ID))
    expect(sentBytes(fetchSpy)).not.toContain(spoofed)
  })
})
