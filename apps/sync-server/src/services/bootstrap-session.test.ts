import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ELEVATION_MULTIPLIERS,
  BOOTSTRAP_RENEW_LEAD_SECONDS,
  BOOTSTRAP_SESSION_TTL_SECONDS,
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
      await expect(renewBootstrapSession(harness.db, SECRET, token)).rejects.toMatchObject({
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

    // #when — a third device opens; the two dead rows must not count
    seedDevice(harness, { deviceId: 'd4', lastCursor: null, vaultId: 'v1' })
    const result = await openBootstrapSession(harness.db, SECRET, {
      userId: 'u1',
      deviceId: 'd4',
      vaultId: 'v1'
    })

    // #then
    expect(result.session.jti).toBeTruthy()
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
    const renewed = await renewBootstrapSession(harness.db, SECRET, opened.token)

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
    await closeBootstrapSession(harness.db, SECRET, opened.token)
    await closeBootstrapSession(harness.db, SECRET, opened.token) // idempotent

    // #then
    const count = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(count.c).toBe(0)
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
