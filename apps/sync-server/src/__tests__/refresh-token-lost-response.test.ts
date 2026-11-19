import { Hono } from 'hono'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RefreshTokenResponseSchema } from '@memry/contracts/auth-api'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { errorHandler } from '../lib/errors'
import { auth } from '../routes/auth'
import { issueTokens } from '../services/auth'
import type { AppContext } from '../types'

/**
 * A desktop whose main thread stalled past its request timeout discarded the
 * answer to a refresh the server had already committed, then retried with the
 * rotated token minutes later and was signed out (staging and production
 * incident, 2026-11-18).
 * This runs the real route over the real migration ledger with real keys, so
 * the grace query, the rotation batch and the JWT checks are the code under test.
 */

const USER_ID = 'user-refresh'
const DEVICE_ID = 'device-refresh'
const START = Date.UTC(2026, 10, 18, 7, 20, 0)

let harness: SqliteD1
let privatePem: string
let publicPem: string

const app = new Hono<AppContext>()
app.onError(errorHandler)
app.route('/auth', auth)

const rateLimiter = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async () => Response.json({ count: 1, windowStart: Math.floor(Date.now() / 1000) })
  })
}

const refresh = (refreshToken: string, db: D1Database = harness.db) =>
  app.request(
    '/auth/refresh',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    },
    {
      DB: db,
      JWT_PUBLIC_KEY: publicPem,
      JWT_PRIVATE_KEY: privatePem,
      RATE_LIMITER: rateLimiter,
      ENVIRONMENT: 'test'
    },
    { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
  )

/** A refresh the client received: the new pair, parsed as clients parse it. */
const refreshed = async (refreshToken: string) => {
  const res = await refresh(refreshToken)
  expect(res.status).toBe(200)
  return RefreshTokenResponseSchema.parse(await res.json())
}

const advance = (seconds: number): void => {
  vi.setSystemTime(Date.now() + seconds * 1000)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 1, 1)`
    )
    .run(USER_ID, `${USER_ID}@example.com`)
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Mac', 'macos', '1.0.0', 'key', 1, 1)`
    )
    .run(DEVICE_ID, USER_ID)
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true
  })
  privatePem = await exportPKCS8(privateKey)
  publicPem = await exportSPKI(publicKey)
})

afterEach(() => {
  harness.close()
  vi.useRealTimers()
})

describe('POST /auth/refresh after a lost response', () => {
  it('re-issues for a rotated token minutes later while its successor is unused', async () => {
    const { refreshToken: held } = await issueTokens(harness.db, USER_ID, DEVICE_ID, privatePem)

    // The server rotates; the stalled client never reads the answer.
    await refreshed(held)
    advance(3 * 60)

    const retried = await refreshed(held)

    // The re-issued pair is a working session.
    advance(60)
    expect((await refresh(retried.refreshToken)).status).toBe(200)
  })

  it('keeps honoring the held token across several lost answers', async () => {
    const { refreshToken: held } = await issueTokens(harness.db, USER_ID, DEVICE_ID, privatePem)

    await refreshed(held)
    advance(2 * 60)
    await refreshed(held)
    advance(3 * 60)
    const received = await refreshed(held)

    advance(60)
    const current = await refreshed(received.refreshToken)

    // Once the client spent the re-issued token, the held one is plain reuse.
    expect((await refresh(held)).status).toBe(401)
    expect((await refresh(current.refreshToken)).status).toBe(401)
  })

  it('treats reuse after the successor was used as theft and ends the device session', async () => {
    const { refreshToken: stolen } = await issueTokens(harness.db, USER_ID, DEVICE_ID, privatePem)
    const first = await refreshed(stolen)
    advance(60)
    const second = await refreshed(first.refreshToken)
    advance(60)

    expect((await refresh(stolen)).status).toBe(401)
    // The legitimate holder's current token went with it.
    expect((await refresh(second.refreshToken)).status).toBe(401)
  })

  it('ends the device session when the rotated token comes back after the grace window', async () => {
    const { refreshToken: held } = await issueTokens(harness.db, USER_ID, DEVICE_ID, privatePem)
    const unseen = await refreshed(held)
    advance(16 * 60)

    expect((await refresh(held)).status).toBe(401)
    expect((await refresh(unseen.refreshToken)).status).toBe(401)
  })
})

/**
 * A D1 whose first two batches wait for each other: both requests have read
 * the token as live before either writes, the interleaving that let two
 * concurrent refreshes each mint a live token.
 */
const racingBatches = (db: D1Database): D1Database => {
  let releaseFirst: (() => void) | null = null
  let waiting = 0
  const raced: D1Database = Object.create(db)
  raced.batch = async <T>(statements: D1PreparedStatement[]) => {
    waiting += 1
    if (waiting === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    } else if (waiting === 2) {
      releaseFirst?.()
      await Promise.resolve()
    }
    return db.batch<T>(statements)
  }
  return raced
}

const liveTokenCount = (): number =>
  (
    harness.raw
      .prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE device_id = ? AND revoked = 0')
      .get(DEVICE_ID) as { n: number }
  ).n

describe('POST /auth/refresh with two requests racing on one token', () => {
  it('rotates the token once and leaves exactly one live token', async () => {
    const { refreshToken: held } = await issueTokens(harness.db, USER_ID, DEVICE_ID, privatePem)
    const db = racingBatches(harness.db)

    const responses = await Promise.all([refresh(held, db), refresh(held, db)])

    // The loser re-reads, finds the winner's unused successor, and is answered
    // through the lost-response grace: both succeed, one family member lives.
    expect(responses.map((res) => res.status)).toEqual([200, 200])
    expect(liveTokenCount()).toBe(1)
    // The surviving token is one the two requests were answered with.
    const answered = await Promise.all(
      responses.map(async (res) => {
        const { refreshToken } = RefreshTokenResponseSchema.parse(await res.json())
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken))
        return Buffer.from(digest).toString('hex')
      })
    )
    const live = harness.raw
      .prepare('SELECT token_hash FROM refresh_tokens WHERE device_id = ? AND revoked = 0')
      .get(DEVICE_ID) as { token_hash: string }
    expect(answered).toContain(live.token_hash)
  })
})
