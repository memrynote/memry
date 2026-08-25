import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ELEVATION_MULTIPLIERS,
  BOOTSTRAP_RENEW_LEAD_SECONDS,
  BOOTSTRAP_SESSION_TTL_SECONDS,
  MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS,
  bootstrapRateLimitElevation,
  closeBootstrapSession,
  isFreshDeviceForVault,
  openBootstrapSession,
  renewBootstrapSession,
  signBootstrapSession,
  verifyBootstrapSession
} from './bootstrap-session'
import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'

const SECRET = 'test-bootstrap-hmac-key'
const NOW = 1_800_000_000

// ---------------------------------------------------------------------------
// Token codec
// ---------------------------------------------------------------------------

describe('bootstrap session tokens', () => {
  it('round-trips a signed session', async () => {
    // #given
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j1' },
      NOW
    )

    // #when
    const verified = await verifyBootstrapSession(SECRET, token, NOW + 10)

    // #then
    expect(verified).toEqual({
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1',
      jti: 'j1',
      expiresAt: NOW + BOOTSTRAP_SESSION_TTL_SECONDS
    })
  })

  it('rejects a tampered payload and an expired token — never throwing', async () => {
    // #given
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j1' },
      NOW
    )
    const [payload] = token.split('.')
    // Swap the userId inside the payload without re-signing.
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    decoded.userId = 'victim'
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${token.split('.')[1]}`

    // #when / #then
    expect(await verifyBootstrapSession(SECRET, forged, NOW)).toBeNull()
    expect(
      await verifyBootstrapSession(SECRET, token, NOW + BOOTSTRAP_SESSION_TTL_SECONDS)
    ).toBeNull()
    expect(await verifyBootstrapSession('other-secret', token, NOW)).toBeNull()
    expect(await verifyBootstrapSession(SECRET, 'garbage', NOW)).toBeNull()
    expect(await verifyBootstrapSession(SECRET, '', NOW)).toBeNull()
  })

  it('renewal refuses an expired or revoked token', async () => {
    // #given
    const harness = createSqliteD1()
    try {
      const { token } = await signBootstrapSession(
        SECRET,
        { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j-live' },
        NOW
      )
      await harness.db
        .prepare(
          `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
         VALUES ('j-live', 'u1', 'd1', 'v1', ?, ?)`
        )
        .bind(NOW + 3600, NOW)
        .run()

      // #when — ledger row removed (closed/revoked)
      await harness.db.prepare('DELETE FROM bootstrap_sessions WHERE jti = ?').bind('j-live').run()

      // #then
      await expect(
        renewBootstrapSession(harness.db, SECRET, token, {
          userId: 'u1',
          deviceId: 'd1',
          vaultId: 'v1'
        })
      ).rejects.toMatchObject({
        statusCode: 401
      })
    } finally {
      harness.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Elevation seam
// ---------------------------------------------------------------------------

interface FakeContextVars {
  env?: Record<string, unknown>
  headers?: Record<string, string>
  vars?: Record<string, string | undefined>
}

const makeContext = ({ env = {}, headers = {}, vars = {} }: FakeContextVars = {}) =>
  ({
    env,
    req: { header: (name: string) => headers[name] },
    get: (key: string) => vars[key]
  }) as never

const bucketOf = (keyPrefix: string) => ({ maxRequests: 600, windowSeconds: 60, keyPrefix })

describe('bootstrapRateLimitElevation', () => {
  it('returns null with no header and no secret — zero-change fast path', async () => {
    expect(await bootstrapRateLimitElevation(makeContext(), bucketOf('crdt_pull'))).toBeNull()
    expect(
      await bootstrapRateLimitElevation(
        makeContext({ env: { BOOTSTRAP_SESSION_HMAC_KEY: SECRET }, headers: {} }),
        bucketOf('crdt_pull')
      )
    ).toBeNull()
  })

  it('returns the documented multiplier per pull bucket with a valid bound token', async () => {
    // #given
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j1' },
      NOW
    )
    const c = makeContext({
      env: { BOOTSTRAP_SESSION_HMAC_KEY: SECRET },
      headers: { 'X-Memry-Bootstrap-Token': token },
      vars: { userId: 'u1', deviceId: 'd1', vaultId: 'v1' }
    })

    // #when / #then — every elevated bucket matches its table entry exactly
    for (const [keyPrefix, multiplier] of Object.entries(BOOTSTRAP_ELEVATION_MULTIPLIERS)) {
      expect(await bootstrapRateLimitElevation(c, bucketOf(keyPrefix))).toBe(multiplier)
    }
    expect(BOOTSTRAP_ELEVATION_MULTIPLIERS.crdt_pull).toBe(5)
    expect(BOOTSTRAP_ELEVATION_MULTIPLIERS.blob_download).toBe(5)
    expect(BOOTSTRAP_ELEVATION_MULTIPLIERS.sync_pull).toBe(3)
  })

  it('does nothing on unrelated buckets even with a valid token', async () => {
    // #given — pushes/uploads/status must keep their abuse ceilings
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j1' },
      NOW
    )
    const c = makeContext({
      env: { BOOTSTRAP_SESSION_HMAC_KEY: SECRET },
      headers: { 'X-Memry-Bootstrap-Token': token },
      vars: { userId: 'u1', deviceId: 'd1', vaultId: 'v1' }
    })

    // #when / #then
    for (const keyPrefix of [
      'sync_push',
      'crdt_push',
      'blob_upload',
      'sync_status',
      'blob_presign'
    ]) {
      expect(await bootstrapRateLimitElevation(c, bucketOf(keyPrefix))).toBeNull()
    }
  })

  it('refuses tokens replayed from another device or vault', async () => {
    // #given — device d2 presents d1's token
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j1' },
      NOW
    )
    const c = makeContext({
      env: { BOOTSTRAP_SESSION_HMAC_KEY: SECRET },
      headers: { 'X-Memry-Bootstrap-Token': token },
      vars: { userId: 'u1', deviceId: 'd2', vaultId: 'v1' }
    })

    // #when / #then
    expect(await bootstrapRateLimitElevation(c, bucketOf('crdt_pull'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Ledger lifecycle over real SQLite (real migrations)
// ---------------------------------------------------------------------------

const seedDevice = (
  harness: SqliteD1,
  opts: { deviceId?: string; lastCursor?: number | null; vaultId?: string } = {}
): void => {
  const now = Math.floor(Date.now() / 1000)
  const deviceId = opts.deviceId ?? 'd1'
  const vaultId = opts.vaultId ?? 'v1'
  // device_sync_state carries an FK to devices.
  harness.raw
    .prepare(
      `INSERT OR IGNORE INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, 'u1', ?, 'desktop', '0.0.0-test', ?, ?, ?, ?)`
    )
    .run(deviceId, `dev-${deviceId}`, `pk-${deviceId}`, vaultId, now, now)
  if (opts.lastCursor !== null) {
    harness.raw
      .prepare(
        `INSERT INTO device_sync_state (device_id, user_id, vault_id, last_cursor_seen, updated_at)
         VALUES (?, 'u1', ?, ?, ?)`
      )
      .run(deviceId, vaultId, opts.lastCursor ?? 42, now)
  }
}

describe('open/renew/close over real SQLite', () => {
  let harness: SqliteD1

  const seedUser = (): void => {
    const now = Math.floor(Date.now() / 1000)
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES ('u1', 'boot@example.com', 1, 'otp', 0, 0, ?, ?)`
      )
      .run(now, now)
  }

  beforeEach(() => {
    harness = createSqliteD1()
    seedUser()
  })

  afterEach(() => {
    harness.close()
  })

  it('opens for a fresh device and persists one ledger row', async () => {
    // #given — no device_sync_state row at all
    seedDevice(harness, { lastCursor: null })

    // #when
    const { session, token } = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #then
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(await verifyBootstrapSession(SECRET, token)).toMatchObject({ jti: session.jti })
    const row = harness.raw
      .prepare('SELECT user_id, device_id, vault_id FROM bootstrap_sessions')
      .get()
    expect(row).toEqual({ user_id: 'u1', device_id: 'd1', vault_id: 'v1' })
  })

  it('refuses a device that has already pulled this vault', async () => {
    // #given
    seedDevice(harness, { lastCursor: 42 })

    // #when / #then — typed 409, the client's silent-fallback signal
    await expect(
      openBootstrapSession(harness.db, SECRET, { userId: 'u1', deviceId: 'd1', vaultId: 'v1' })
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_NOT_ELIGIBLE', statusCode: 409 })
  })

  it('enforces the per-user concurrent session cap', async () => {
    // #given — two other devices of the same user already hold sessions
    seedDevice(harness, { deviceId: 'd2', lastCursor: null, vaultId: 'v1' })
    seedDevice(harness, { deviceId: 'd3', lastCursor: null, vaultId: 'v1' })
    await openBootstrapSession(harness.db, SECRET, { userId: 'u1', deviceId: 'd2', vaultId: 'v1' })
    await openBootstrapSession(harness.db, SECRET, { userId: 'u1', deviceId: 'd3', vaultId: 'v1' })
    seedDevice(harness, { deviceId: 'd4', lastCursor: null, vaultId: 'v1' })

    // #when / #then — the third concurrent open is capped at 429
    await expect(
      openBootstrapSession(harness.db, SECRET, { userId: 'u1', deviceId: 'd4', vaultId: 'v1' })
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_SESSION_LIMIT', statusCode: 429 })
  })

  it('lazily prunes expired rows before counting the cap', async () => {
    // #given — two sessions, both already expired
    const past = Math.floor(Date.now() / 1000) - 10
    seedDevice(harness, { deviceId: 'd2', lastCursor: null, vaultId: 'v1' })
    seedDevice(harness, { deviceId: 'd3', lastCursor: null, vaultId: 'v1' })
    harness.raw
      .prepare(
        `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
         VALUES ('old-1', 'u1', 'd2', 'v1', ?, ?), ('old-2', 'u1', 'd3', 'v1', ?, ?)`
      )
      .bind(past, past - 100, past, past - 100)
      .run()

    // #when — a third device opens; the two dead rows must not count
    seedDevice(harness, { deviceId: 'd4', lastCursor: null, vaultId: 'v1' })
    const result = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd4',
      vaultId: 'v1'
    })

    // #then — the dead rows are gone and only the fresh session survives, so
    // stale rows can never wedge a user at the cap until cron cleanup.
    const rows = harness.raw
      .prepare("SELECT jti FROM bootstrap_sessions WHERE user_id = 'u1' ORDER BY jti")
      .all() as Array<{ jti: string }>
    expect(rows.map((row) => row.jti)).toEqual([result.session.jti])
  })

  it('renews in place under the same jti and extends the ledger', async () => {
    // #given
    seedDevice(harness, { lastCursor: null })
    const opened = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #when
    const renewed = await renewBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #then — new expiry beyond the old one, same identity, still ONE row
    expect(renewed.session.jti).toBe(opened.session.jti)
    expect(renewed.session.expiresAt).toBeGreaterThanOrEqual(opened.session.expiresAt)
    const count = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(count.c).toBe(1)
    expect(await verifyBootstrapSession(SECRET, renewed.token)).toMatchObject({
      jti: opened.session.jti
    })
  })

  it('closes idempotently and releases the cap slot', async () => {
    // #given
    seedDevice(harness, { lastCursor: null })
    const opened = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #when
    await closeBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })
    await closeBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    }) // idempotent

    // #then
    const count = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(count.c).toBe(0)
  })

  it('refuses renewal from any other authenticated context — cross-device, cross-user, cross-vault', async () => {
    // #given — d1 of u1/v1 holds a live session
    seedDevice(harness, { lastCursor: null })
    const opened = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    const mismatches = [
      { userId: 'u1', deviceId: 'd-other', vaultId: 'v1' }, // stolen token, other device
      { userId: 'u-other', deviceId: 'd1', vaultId: 'v1' }, // other user
      { userId: 'u1', deviceId: 'd1', vaultId: 'v-other' } // other vault
    ]

    // #when / #then — bearer possession alone never renews anything (403),
    // and the ledger row is untouched in every case.
    for (const identity of mismatches) {
      await expect(
        renewBootstrapSession(harness.db, SECRET, opened.token, identity)
      ).rejects.toMatchObject({
        code: 'BOOTSTRAP_IDENTITY_MISMATCH',
        statusCode: 403
      })
    }
    const row = harness.raw
      .prepare('SELECT jti FROM bootstrap_sessions WHERE jti = ?')
      .get(opened.session.jti)
    expect(row).toBeTruthy()
  })

  it('applies the same identity rules to close', async () => {
    // #given
    seedDevice(harness, { lastCursor: null })
    const opened = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #when / #then — a mismatched close is refused and closes NOTHING…
    await expect(
      closeBootstrapSession(harness.db, SECRET, opened.token, {
        userId: 'u1',
        deviceId: 'd-other',
        vaultId: 'v1'
      })
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_IDENTITY_MISMATCH', statusCode: 403 })
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 1 }
    )

    // …and the owner's own close still tears it down idempotently.
    await closeBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })
    await closeBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 0 }
    )
  })

  it('refuses renewal past the absolute max lifetime and frees the cap slot', async () => {
    // #given — a session whose ledger row was created MAX_LIFETIME ago; the
    // token itself was re-signed "recently" so only the created_at bound can
    // catch it.
    seedDevice(harness, { lastCursor: null })
    const oldCreated = Math.floor(Date.now() / 1000) - MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS - 5
    harness.raw
      .prepare(
        `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
         VALUES ('j-old', 'u1', 'd1', 'v1', ?, ?)`
      )
      .bind(Math.floor(Date.now() / 1000) + 3600, oldCreated)
      .run()
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'u1', deviceId: 'd1', vaultId: 'v1', jti: 'j-old' },
      Math.floor(Date.now() / 1000)
    )

    // #when / #then — typed expiry, NOT the generic invalid-token 401
    await expect(
      renewBootstrapSession(harness.db, SECRET, token, {
        userId: 'u1',
        deviceId: 'd1',
        vaultId: 'v1'
      })
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_SESSION_EXPIRED', statusCode: 403 })

    // #and the dead row is dropped so it cannot pin a concurrency slot
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 0 }
    )
  })

  it('renews within the max lifetime', async () => {
    // #given — a session created just now
    seedDevice(harness, { lastCursor: null })
    const opened = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })

    // #when / #then — well inside the ceiling, so sliding renewal still works
    expect(MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS).toBeGreaterThan(
      BOOTSTRAP_SESSION_TTL_SECONDS + BOOTSTRAP_RENEW_LEAD_SECONDS
    )
    const renewed = await renewBootstrapSession(harness.db, SECRET, opened.token, {
      userId: 'u1',
      deviceId: 'd1',
      vaultId: 'v1'
    })
    expect(renewed.session.jti).toBe(opened.session.jti)
  })

  it('holds the per-user cap when a competitor completes mid-admission', async () => {
    // #given — one live slot held; a second open (d3) will be PARKED at its
    // ledger INSERT while a third device (d4) completes a full open around it.
    // This is exactly the TOCTOU window the old COUNT-then-INSERT had: by the
    // time the parked open resumes, its earlier count is stale. Admission must
    // therefore be decided INSIDE the INSERT statement itself.
    seedDevice(harness, { deviceId: 'd2', lastCursor: null })
    await openBootstrapSession(harness.db, SECRET, { userId: 'u1', deviceId: 'd2', vaultId: 'v1' })
    seedDevice(harness, { deviceId: 'd3', lastCursor: null })
    seedDevice(harness, { deviceId: 'd4', lastCursor: null })

    const realPrepare = harness.db.prepare.bind(harness.db)
    let gatedCallsLeft = 1
    let released = false
    let parkedAtInsert = false
    let releasePark!: () => void
    const parkGate = new Promise<void>((resolve) => {
      releasePark = resolve
    })
    ;(harness.db as unknown as { prepare: typeof realPrepare }).prepare = (sql: string) => {
      const inner = realPrepare(sql)
      if (!sql.includes('INSERT INTO bootstrap_sessions')) return inner
      const wrapped = {
        bind: (...args: unknown[]) => {
          inner.bind(...args)
          return wrapped
        },
        first: inner.first.bind(inner),
        all: inner.all.bind(inner),
        raw: inner.raw.bind(inner),
        run: async () => {
          const shouldPark = !released && gatedCallsLeft > 0
          if (gatedCallsLeft > 0) gatedCallsLeft--
          if (shouldPark) {
            parkedAtInsert = true
            await parkGate
          }
          return inner.run()
        }
      }
      return wrapped as unknown as D1PreparedStatement
    }

    try {
      // #when — d3 parks at its INSERT…
      const third = openBootstrapSession(harness.db, SECRET, {
        userId: 'u1',
        deviceId: 'd3',
        vaultId: 'v1'
      })
      while (!parkedAtInsert) await new Promise((r) => setTimeout(r, 0))

      // …d4 slips a complete open through the gap…
      await openBootstrapSession(harness.db, SECRET, {
        userId: 'u1',
        deviceId: 'd4',
        vaultId: 'v1'
      })
      releasePark()

      // #then — resumed d3 re-evaluates the cap at INSERT time and is refused;
      // exactly the cap's worth of LIVE rows exist, both attributable.
      await expect(third).rejects.toMatchObject({
        code: 'BOOTSTRAP_SESSION_LIMIT',
        statusCode: 429
      })
      const holders = harness.raw
        .prepare(
          `SELECT device_id FROM bootstrap_sessions WHERE user_id = 'u1' AND expires_at > ?
           ORDER BY device_id`
        )
        .all(Math.floor(Date.now() / 1000)) as { device_id: string }[]
      expect(holders.map((r) => r.device_id)).toEqual(['d2', 'd4'])
    } finally {
      ;(harness.db as unknown as { prepare: typeof realPrepare }).prepare = realPrepare
    }
  })

  it('isFreshDeviceForVault reads the same signal the client cursor gate uses', async () => {
    // #given
    seedDevice(harness, { lastCursor: 42 })
    seedDevice(harness, { deviceId: 'd-zero', lastCursor: 0 })

    // #when / #then
    expect(await isFreshDeviceForVault(harness.db, 'u1', 'd-none', 'v1')).toBe(true)
    expect(await isFreshDeviceForVault(harness.db, 'u1', 'd-zero', 'v1')).toBe(true)
    expect(await isFreshDeviceForVault(harness.db, 'u1', 'd1', 'v1')).toBe(false)
  })

  it('keeps the renewal lead strictly inside the TTL', () => {
    expect(BOOTSTRAP_RENEW_LEAD_SECONDS).toBeLessThan(BOOTSTRAP_SESSION_TTL_SECONDS)
    expect(BOOTSTRAP_SESSION_TTL_SECONDS).toBe(3600)
  })
})
