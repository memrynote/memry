import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { createMemoryQueue } from '../__tests__/pack-queue-memory'
import { errorHandler } from '../lib/errors'
import {
  BOOTSTRAP_RESUME_WINDOW_SECONDS,
  signBootstrapSession,
  verifyBootstrapSession
} from '../services/bootstrap-session'
import { BOOTSTRAP_ENQUEUE_SKIP_SECONDS, COVERAGE_COUNT_CAP } from '../services/pack-coverage'
import type { AppContext } from '../types'
import type * as RateLimitModule from '../middleware/rate-limit'

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    c.set('vaultId', 'vault-1')
    await next()
  })
}))

vi.mock('../middleware/paid-sync', () => ({
  paidSyncMiddleware: vi.fn().mockImplementation(async (_c: any, next: any) => {
    await next()
  })
}))

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimitModule>()
  return {
    ...actual,
    createRateLimiter: vi.fn().mockImplementation(() => async (_c: any, next: any) => {
      await next()
    })
  }
})

const { syncTypes } = vi.hoisted(() => ({ syncTypes: { value: ['note', 'task'] as string[] } }))

vi.mock('../middleware/sync-types', () => ({
  syncTypesMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('syncSubscription', { recordTypes: syncTypes.value, noteBodies: false })
    await next()
  })
}))

// Real manifest + chunk services over real SQLite. Presign availability is
// driven purely by env bindings (the real resolver), so the degradation path
// is exercised without any mock.

import { bootstrap } from './bootstrap'

const SECRET = 'test-bootstrap-hmac-key'
const R2_ENV = {
  R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
  R2_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  R2_S3_BUCKET: 'test-bucket'
}

let harness: SqliteD1

// Work the route hands to waitUntil, for tests to await after the response.
let background: Array<Promise<unknown>> = []

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync/bootstrap', bootstrap)
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
    passThroughOnException: () => undefined
  } as unknown as ExecutionContext
  return {
    request: (path: string, init: RequestInit, env: Record<string, unknown>) =>
      app.request(path, init, env, ctx)
  }
}

const now = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  background = []
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES ('user-1', 'boot@example.com', 1, 'otp', 0, 0, ?, ?)`
    )
    .run(now(), now())
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

const seedDevice = (
  opts: { deviceId?: string; lastCursor?: number | null; registeredAgoSeconds?: number } = {}
): void => {
  const ts = now() - (opts.registeredAgoSeconds ?? 0)
  const deviceId = opts.deviceId ?? 'device-1'
  harness.raw
    .prepare(
      `INSERT OR IGNORE INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, 'user-1', ?, 'desktop', '0.0.0-test', ?, 'vault-1', ?, ?)`
    )
    .run(deviceId, `dev-${deviceId}`, `pk-${deviceId}`, ts, ts)
  if (opts.lastCursor !== null) {
    harness.raw
      .prepare(
        `INSERT INTO device_sync_state (device_id, user_id, vault_id, last_cursor_seen, updated_at)
         VALUES (?, 'user-1', 'vault-1', ?, ?)`
      )
      .run(deviceId, opts.lastCursor ?? 42, ts)
  }
}

const seedItem = (itemId: string, cursor: number): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_items (
         id, user_id, vault_id, item_type, item_id, blob_key, size_bytes,
         content_hash, version, crypto_version, operation, signature,
         server_cursor, deleted_at, created_at, updated_at
       ) VALUES (?, 'user-1', 'vault-1', 'task', ?, ?, ?, ?, 1, 1, 'update', 'sig', ?, NULL, ?, ?)`
    )
    .run(`row-${itemId}`, itemId, `${itemId}-blob`, 64, `hash-${itemId}`, cursor, now(), now())
}

const seedChunk = (hash: string): void => {
  harness.raw
    .prepare(
      `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
       VALUES (?, ?, 'user-1', 'vault-1', ?, 1024, 1, ?)`
    )
    .run(`chunk-${hash}`, hash, `user-1/vaults/vault-1/chunks/${hash}`, now())
}

describe('POST /sync/bootstrap', () => {
  it('answers 501 with a typed code when the deployment has no signing key', async () => {
    // #given — no BOOTSTRAP_SESSION_HMAC_KEY binding at all
    const app = createApp()
    const res = await app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development'
      }
    )

    // #then
    expect(res.status).toBe(501)
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- rule false positive: the awaited value is unknown, removing the cast fails typecheck
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_UNAVAILABLE'
    )
  })

  it('refuses a device that already synced this vault with a typed 409', async () => {
    // #given — registered past the resume window
    seedDevice({ lastCursor: 42, registeredAgoSeconds: BOOTSTRAP_RESUME_WINDOW_SECONDS })
    const app = createApp()

    // #when
    const res = await app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )

    // #then — the client's silent-fallback signal
    expect(res.status).toBe(409)
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- rule false positive: the awaited value is unknown, removing the cast fails typecheck
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_NOT_ELIGIBLE'
    )
  })

  it('reopens for a device resuming an interrupted first sync', async () => {
    // #given — one refs page landed (cursor 42), then iOS killed the app.
    // Production: 18 refusals, and the resumed run paced at a fifth of the speed.
    seedDevice({ lastCursor: 42, registeredAgoSeconds: 8 * 60 * 60 })
    const app = createApp()

    // #when
    const res = await app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )

    // #then
    expect(res.status).toBe(200)
  })

  it('opens a session for a fresh device carrying manifest page + tail cursor + empty pack page', async () => {
    // #given
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 3; i++) seedItem(`item-${i}`, i * 10)
    const app = createApp()

    // #when
    const res = await app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )
    const body = (await res.json()) as Record<string, any>

    // #then — first manifest page only, tail cursor is MAX(server_cursor),
    // no packs and no coverage yet, and NO attachments key without presign config.
    expect(res.status).toBe(200)
    expect(body.manifest.items.map((i: { id: string }) => i.id)).toEqual([
      'item-1',
      'item-2',
      'item-3'
    ])
    expect('nextCursor' in body.manifest).toBe(false)
    expect(body.tailCursor).toBe(30)
    expect(body.packs).toEqual([])
    expect(body.coverage).toEqual([])
    expect('packsNextCursor' in body).toBe(false)
    expect('attachments' in body).toBe(false)

    // The token verifies and binds to this exact device + vault.
    const verified = await verifyBootstrapSession(SECRET, body.session.token)
    expect(verified).toMatchObject({ userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1' })
    expect(body.session.expiresAt).toBe(verified?.expiresAt)
  })

  it('includes a bounded chunk-hash page when presign is configured', async () => {
    // #given — one past the page size, so the first page must report a cursor
    seedDevice({ lastCursor: null })
    const total = 513
    for (let i = 0; i < total; i++) {
      seedChunk(`h${String(i).padStart(63, '0')}`)
    }
    const app = createApp()

    // #when
    const res = await app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
        ...R2_ENV
      }
    )
    const body = (await res.json()) as Record<string, any>

    // #then — keyset page in hash order, cursor names the last hash served
    expect(body.attachments.chunkHashes).toHaveLength(512)
    expect(body.attachments.chunkHashes[0]).toBe(`h${'0'.repeat(63)}`)
    expect(body.attachments.nextChunkCursor).toBe(`h${String(511).padStart(63, '0')}`)
  })
})

describe('POST /sync/bootstrap pack coverage (#5230)', () => {
  const seedRecordPack = (id: string, from: number, through: number): void => {
    harness.raw
      .prepare(
        `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at, cover_from, cover_through)
         VALUES (?, 'user-1', 'vault-1', ?, 'record', ?, ?, 1, 64, 1, ?, ?)`
      )
      .run(id, `user-1/vaults/vault-1/packs/record/${id}.pack`, from + 1, through, from, through)
  }
  const seedRecordWatermark = (lastSortValue: number, coveredThrough: number | null): void => {
    harness.raw
      .prepare(
        `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at, covered_through)
         VALUES ('user-1', 'vault-1', 'record', ?, '', 1, ?)`
      )
      .run(lastSortValue, coveredThrough)
  }
  const open = async (extra: Record<string, unknown> = {}) => {
    const res = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      { DB: harness.db, ENVIRONMENT: 'development', BOOTSTRAP_SESSION_HMAC_KEY: SECRET, ...extra }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    await Promise.all(background)
    return body
  }
  const coverageLog = (info: { mock: { calls: unknown[][] } }) =>
    info.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { message: string; kinds?: unknown })
      .find((entry) => entry.message === 'bootstrap pack coverage')

  it('returns the first pack page and its coverage, so no listing request is needed', async () => {
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 3; i++) seedItem(`item-${i}`, i * 10)
    seedRecordPack('p1', 0, 20)
    seedRecordPack('p2', 20, 30)
    seedRecordWatermark(30, 30)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)

    const body = await open(R2_ENV)

    expect(body.coverage).toEqual([{ itemKind: 'record', packedThrough: 30, coveredThrough: 30 }])
    expect(
      body.packs.map((pack: Record<string, unknown>) => [
        pack.id,
        pack.coverFrom,
        pack.coverThrough
      ])
    ).toEqual([
      ['p2', 20, 30],
      ['p1', 0, 20]
    ])
    expect(body.packs[0].url).toMatch(/^https:/)
    expect('packsNextCursor' in body).toBe(false)
  })

  it('logs coverage per kind and starts an under-covered kind on the backfill queue', async () => {
    // #given: 300 records and no pack yet, past the minimum fill
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    const nudges = createMemoryQueue()
    const backfills = createMemoryQueue()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    // #when
    const body = await open({ PACK_QUEUE: nudges, PACK_BACKFILL_QUEUE: backfills })

    // #then: the client is told nothing is covered and takes it item by item;
    // the record chain starts on the backfill queue, so no nudge waits behind it
    expect(body.coverage).toEqual([])
    expect(backfills.sent).toEqual([
      { body: { userId: 'user-1', vaultId: 'vault-1', backfill: { kind: 'record', hop: 0 } } }
    ])
    expect(nudges.sent).toEqual([])
    expect(coverageLog(info)?.kinds).toEqual([
      {
        kind: 'crdt_snapshot',
        covered: false,
        uncoveredRows: 0,
        reason: 'cache_only',
        enqueued: false
      },
      {
        kind: 'record',
        covered: false,
        uncoveredRows: COVERAGE_COUNT_CAP,
        reason: 'never_packed',
        enqueued: true
      },
      {
        kind: 'crdt_update',
        covered: false,
        uncoveredRows: 0,
        reason: 'cache_only',
        enqueued: false
      }
    ])
  })

  it('enqueues an unanchored record chain whatever its backlog, and nothing for a covered vault', async () => {
    seedDevice({ lastCursor: null })
    seedItem('item-1', 10)
    seedRecordWatermark(10, null)
    const backfills = createMemoryQueue()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await open({ PACK_BACKFILL_QUEUE: backfills })
    expect(backfills.sent.map((sent) => sent.body.backfill?.kind)).toEqual(['record'])

    harness.raw.prepare('UPDATE pack_watermarks SET covered_through = 10').run()
    harness.raw.prepare('DELETE FROM pack_bootstrap_enqueues').run()
    backfills.sent.length = 0
    info.mockClear()
    await open({ PACK_BACKFILL_QUEUE: backfills })
    expect(backfills.sent).toEqual([])
    expect(coverageLog(info)?.kinds).toContainEqual({
      kind: 'record',
      covered: true,
      uncoveredRows: 0,
      enqueued: false
    })
  })

  it('a failed coverage report never fails the open', async () => {
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    const backfills = createMemoryQueue()
    backfills.sendBatch = async () => {
      throw new Error('queue down')
    }
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
        PACK_BACKFILL_QUEUE: backfills
      }
    )

    expect(res.status).toBe(200)
    await Promise.allSettled(background)
  })

  it('a failed chain start still logs coverage and leaves the kind to the next open', async () => {
    // #given: a backlog a build can extend, and a backfill queue that refuses one send
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    const backfills = createMemoryQueue()
    const sendBatch = backfills.sendBatch
    backfills.sendBatch = async () => {
      backfills.sendBatch = sendBatch
      throw new Error('queue down')
    }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // #when
    const body = await open({ PACK_BACKFILL_QUEUE: backfills })

    // #then: the open logs the kind as not enqueued
    expect(coverageLog(info)?.kinds).toContainEqual(
      expect.objectContaining({ kind: 'record', enqueued: false })
    )

    // #when: the next open, inside the skip window
    const closed = await createApp().request(
      '/sync/bootstrap/close',
      { method: 'POST', headers: { 'X-Memry-Bootstrap-Token': body.session.token } },
      { DB: harness.db, ENVIRONMENT: 'development', BOOTSTRAP_SESSION_HMAC_KEY: SECRET }
    )
    expect(closed.status).toBe(200)
    await open({ PACK_BACKFILL_QUEUE: backfills })

    // #then: it starts the chain the failed send did not
    expect(backfills.sent).toEqual([
      { body: { userId: 'user-1', vaultId: 'vault-1', backfill: { kind: 'record', hop: 0 } } }
    ])
  })

  // The PR states subrequests per bootstrap. Before #5230 an open made 6 D1
  // calls on this seed, and the client then listed packs in a second request.
  // Now: the listing batch in the response, and in waitUntil the coverage
  // batch, the chain-start claim batch and one queue send.
  it('costs three D1 batches and one queue send more than before, and no listing request', async () => {
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    const backfills = createMemoryQueue()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let calls = 0
    const tally =
      <A extends unknown[], R>(call: (...args: A) => R) =>
      (...args: A): R => {
        calls++
        return call(...args)
      }
    // The harness's bind returns the statement itself: wrap each one once.
    const wrapped = new WeakSet<D1PreparedStatement>()
    const countStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
      if (wrapped.has(statement)) return statement
      wrapped.add(statement)
      const bind = statement.bind.bind(statement)
      return Object.assign(statement, {
        bind: (...values: unknown[]) => countStatement(bind(...values)),
        first: tally(statement.first.bind(statement)),
        all: tally(statement.all.bind(statement)),
        run: tally(statement.run.bind(statement)),
        raw: tally(statement.raw.bind(statement))
      })
    }
    const db = harness.db
    const counted: D1Database = Object.assign(Object.create(db) as D1Database, {
      prepare: (sql: string) => countStatement(db.prepare(sql)),
      batch: tally(db.batch.bind(db))
    })

    const res = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: counted,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
        PACK_BACKFILL_QUEUE: backfills,
        ...R2_ENV
      }
    )
    expect(res.status).toBe(200)
    await Promise.all(background)
    expect(calls).toBe(9)
    expect(backfills.sent).toHaveLength(1)
  })

  it('starts a kind once per window however often the vault opens and closes', async () => {
    // #given: a backlog a build can extend on every open (REVIEW-5291 P4)
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    const nudges = createMemoryQueue()
    const backfills = createMemoryQueue()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['Date'] })
    const cycle = async () => {
      const body = await open({ PACK_QUEUE: nudges, PACK_BACKFILL_QUEUE: backfills })
      const closed = await createApp().request(
        '/sync/bootstrap/close',
        { method: 'POST', headers: { 'X-Memry-Bootstrap-Token': body.session.token } },
        { DB: harness.db, ENVIRONMENT: 'development', BOOTSTRAP_SESSION_HMAC_KEY: SECRET }
      )
      expect(closed.status).toBe(200)
    }
    try {
      // #when: five open/close cycles inside the window
      for (let i = 0; i < 5; i++) await cycle()

      // #then: one chain start, on the backfill queue, none on the nudge queue
      expect(backfills.sent).toEqual([
        { body: { userId: 'user-1', vaultId: 'vault-1', backfill: { kind: 'record', hop: 0 } } }
      ])
      expect(nudges.sent).toEqual([])

      // #when: an open once the window has passed starts the kind again
      vi.setSystemTime(Date.now() + BOOTSTRAP_ENQUEUE_SKIP_SECONDS * 1000)
      await cycle()
      expect(backfills.sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads coverage with bounded index seeks, whatever the backlog (REVIEW-5291 P6)', async () => {
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 300; i++) seedItem(`item-${i}`, i)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const statements: string[] = []
    const db = harness.db
    const recording: D1Database = Object.assign(Object.create(db) as D1Database, {
      prepare: (sql: string) => {
        statements.push(sql)
        return db.prepare(sql)
      }
    })
    const res = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      { DB: recording, ENVIRONMENT: 'development', BOOTSTRAP_SESSION_HMAC_KEY: SECRET }
    )
    expect(res.status).toBe(200)
    await Promise.all(background)

    const coverageReads = statements.filter((sql) => sql.includes('AS has_watermark'))
    expect(coverageReads).toHaveLength(3)
    for (const sql of coverageReads) {
      const plan = (
        harness.raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all('u', 'v', 'u', 'v', 'u', 'v', 'u', 'v', 'record') as Array<{ detail: string }>
      ).map((row) => row.detail)
      // Every source read is an index search, and the first-row read needs no sort.
      expect(
        plan.filter((detail) => / s\b/.test(detail)).every((d) => d.startsWith('SEARCH'))
      ).toBe(true)
      expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/)
    }
  })
})

describe('POST /sync/bootstrap/renew + /close', () => {
  const openSession = async (): Promise<Response> => {
    const app = createApp()
    return app.request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
        ...R2_ENV
      }
    )
  }

  const requestWithToken = async (
    path: string,
    token: string,
    deviceId?: string
  ): Promise<Response> => {
    const app = createApp()
    if (deviceId) {
      const { authMiddleware } = await import('../middleware/auth')
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('userId', 'user-1')
        c.set('deviceId', deviceId)
        c.set('vaultId', 'vault-1')
        await next()
      })
    }
    return app.request(
      path,
      { method: 'POST', headers: { 'X-Memry-Bootstrap-Token': token } },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )
  }

  it('renews before expiry and extends the same ledger row', async () => {
    // #given
    seedDevice({ lastCursor: null })
    const openRes = await openSession()
    const opened = (await openRes.json()) as Record<string, any>

    // #when
    const renewRes = await requestWithToken('/sync/bootstrap/renew', opened.session.token)
    const renewed = (await renewRes.json()) as Record<string, any>

    // #then
    expect(renewRes.status).toBe(200)
    expect(renewed.session.expiresAt).toBeGreaterThanOrEqual(opened.session.expiresAt)
    const rows = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(rows.c).toBe(1)
    expect(await verifyBootstrapSession(SECRET, renewed.session.token)).toMatchObject({
      jti: (await verifyBootstrapSession(SECRET, opened.session.token))?.jti
    })
  })

  it('rejects renewal with a missing or forged token', async () => {
    // #given
    const app = createApp()

    // #when / #then
    const noToken = await app.request(
      '/sync/bootstrap/renew',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )
    expect(noToken.status).toBe(401)

    const forged = await requestWithToken('/sync/bootstrap/renew', 'aaa.bbb')
    expect(forged.status).toBe(401)

    const { token } = await signBootstrapSession(
      'other-secret',
      { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', jti: 'j-forged' },
      now()
    )
    const wrongSecret = await requestWithToken('/sync/bootstrap/renew', token)
    expect(wrongSecret.status).toBe(401)
  })

  it('rejects renewal presented by another device — identity-bound (403)', async () => {
    // #given — device-1 holds a live session
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>

    // #when — device-2 replays the stolen-but-valid token
    const stolen = await requestWithToken('/sync/bootstrap/renew', opened.session.token, 'device-2')
    const body = (await stolen.json()) as { error: { code: string } }

    // #then — typed 403, ledger row untouched
    expect(stolen.status).toBe(403)
    expect(body.error.code).toBe('BOOTSTRAP_IDENTITY_MISMATCH')
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 1 }
    )
  })

  it('rejects close presented by another device', async () => {
    // #given
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>

    // #when / #then — mismatched close refused, session survives
    const stolenClose = await requestWithToken(
      '/sync/bootstrap/close',
      opened.session.token,
      'device-2'
    )
    expect(stolenClose.status).toBe(403)
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- rule false positive: the awaited value is unknown, removing the cast fails typecheck
    expect(((await stolenClose.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_IDENTITY_MISMATCH'
    )
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 1 }
    )

    // #and the owner's own close still succeeds
    const ownClose = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(ownClose.status).toBe(200)
  })

  it('answers a typed expiry once the absolute max lifetime is spent', async () => {
    // #given — a live-looking token whose ledger row was created MAX_LIFETIME ago
    seedDevice({ lastCursor: null })
    const past = now() - 6 * 60 * 60 - 10
    harness.raw
      .prepare(
        `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
         VALUES ('j-max', 'user-1', 'device-1', 'vault-1', ?, ?)`
      )
      .bind(now() + 3600, past)
      .run()
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', jti: 'j-max' },
      now()
    )

    // #when
    const res = await requestWithToken('/sync/bootstrap/renew', token)
    const body = (await res.json()) as { error: { code: string } }

    // #then — 403 SESSION_EXPIRED (the client's normal close→fallback signal),
    // and the dead row is gone so it cannot pin a concurrency slot.
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('BOOTSTRAP_SESSION_EXPIRED')
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 0 }
    )
  })

  it('closes idempotently and frees the concurrent-session slot', async () => {
    // #given — device A opens and closes; device B must then be able to open
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>
    const closeRes = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(closeRes.status).toBe(200)
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- rule false positive: the awaited value is unknown, removing the cast fails typecheck
    expect(((await closeRes.json()) as Record<string, unknown>).success).toBe(true)

    // #when — closing again is still 200
    const closeAgain = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(closeAgain.status).toBe(200)

    // #then — the slot is free
    const rows = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(rows.c).toBe(0)
  })

  it('enforces the per-user cap across devices at the route level', async () => {
    // #given — two fresh devices hold sessions
    seedDevice({ lastCursor: null })
    await openSession()
    seedDevice({ deviceId: 'device-2', lastCursor: null })
    const { authMiddleware } = await import('../middleware/auth')
    const as = (deviceId: string): void => {
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('userId', 'user-1')
        c.set('deviceId', deviceId)
        c.set('vaultId', 'vault-1')
        await next()
      })
    }
    as('device-2')
    const second = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )
    expect(second.status).toBe(200)

    // #when — a third fresh device tries
    seedDevice({ deviceId: 'device-3', lastCursor: null })
    as('device-3')
    const third = await createApp().request(
      '/sync/bootstrap',
      { method: 'POST' },
      {
        DB: harness.db,
        ENVIRONMENT: 'development',
        BOOTSTRAP_SESSION_HMAC_KEY: SECRET
      }
    )

    // #then
    expect(third.status).toBe(429)
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- rule false positive: the awaited value is unknown, removing the cast fails typecheck
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_SESSION_LIMIT'
    )
  })
})
