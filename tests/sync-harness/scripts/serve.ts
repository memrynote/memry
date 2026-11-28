/**
 * The real Worker on miniflare (`SimulatedServer`: D1 migrations, R2, Durable Objects) for a
 * client outside Node, such as the Rust core's harness tests
 * (`crates/memry-desktop/tests/sync_harness.rs`).
 *
 * It registers one user with `DEVICES` devices (default 2), prints one JSON line on stdout,
 * `{ url, userId, devices: [{ deviceId, accessToken, signingSecretKey }] }` (the key as
 * base64, libsodium's 64-byte form), and serves until stdin closes.
 *
 * The user has account key material, and the line carries `recovery`: `{ kdfSalt, keyVerifier,
 * setupToken }` for that user, and `setupTokenNoKeys` for a second user with none (chapter 02
 * §2.7, `GET /auth/recovery-info`).
 *
 * A `purge` line on stdin ends the user's retention (`version_history_days` 0, as for a user with
 * no entitlement row) and runs the Worker's cron, whose `cleanupExpiredTombstones` sheds every
 * tombstone from an earlier second to a marker (chapter 05 §5.12.3). It answers
 * `{ harnessMarkers }`, the marker count, on stdout.
 *
 * A `register` line registers one more device for the same user, as a device signing in after
 * the others started, and answers `{ harnessDevice }` in the bootstrap's device shape.
 *
 * An `otp <email> <code>` line makes `<code>` the email's pending sign-in code, as the server's
 * `storeOtp` stores one (the email normalized, the code's HMAC-SHA256 under the harness key), so
 * a client can finish an email sign-in without the email. It answers `{ harnessOtp: true }`.
 *
 * An `entitle <email>` line gives the user who signed in with `<email>` the bootstrap user's paid
 * plan, so it can add vaults to its account (`POST /sync/vaults`). It answers
 * `{ harnessEntitled: true }`.
 *
 * A `lose <itemId>` line deletes the user's every server row of `<itemId>`: its records and its
 * body (`sync_items`, `crdt_updates`, `crdt_snapshots`), as a server that lost the create (a D1
 * restore, a lost write). It answers `{ harnessLost }`, the record rows deleted.
 *
 * A `file-limit <bytes>` line sets the bootstrap user's `max_file_size`, so a larger attachment
 * gets the Worker's 413 `STORAGE_FILE_TOO_LARGE`. It answers `{ harnessFileLimit: true }`.
 *
 * A `policy <writesEnabled 0|1> [minWriteVersion]` line upserts the `desktop` row of
 * `client_policies` (chapter 11 §11.8), which the Worker reads on every request. It answers
 * `{ harnessPolicy: true }`.
 */
import { createHmac } from 'node:crypto'
import { createInterface } from 'node:readline'
import { base64_variants, to_base64 } from 'libsodium-wrappers-sumo'
import { SimulatedServer } from '../src/simulated-server.js'
import { createTestDevice } from '../src/test-auth.js'

const count = Number(process.env.DEVICES ?? '2')
const server = new SimulatedServer()
await server.start()

const userId = crypto.randomUUID()
const register = async (at: number) => {
  const device = await createTestDevice(server, { userId, deviceName: `harness-${at}` })
  return {
    deviceId: device.deviceId,
    accessToken: device.accessToken,
    signingSecretKey: to_base64(device.signingSecretKey, base64_variants.ORIGINAL)
  }
}
const devices = []
for (let at = 0; at < count; at += 1) {
  devices.push(await register(at))
}

const kdfSalt = to_base64(new Uint8Array(16).fill(7), base64_variants.ORIGINAL)
const keyVerifier = to_base64(new Uint8Array(32).fill(5), base64_variants.ORIGINAL)
const accountDb = await server.getD1()
await accountDb
  .prepare('UPDATE users SET kdf_salt = ?, key_verifier = ? WHERE id = ?')
  .bind(kdfSalt, keyVerifier, userId)
  .run()
const recovery = { kdfSalt, keyVerifier, setupToken: await server.createSetupToken(userId) }
const keyless = await createTestDevice(server, { deviceName: 'harness-keyless' })
const setupTokenNoKeys = await server.createSetupToken(keyless.userId)

const url = (await server.getDirectUrl()).toString().replace(/\/$/, '')
process.stdout.write(`${JSON.stringify({ url, userId, devices, recovery, setupTokenNoKeys })}\n`)

const stop = async (): Promise<void> => {
  await server.stop()
  process.exit(0)
}
const purge = async (): Promise<void> => {
  const db = await server.getD1()
  await db.prepare('UPDATE sync_entitlements SET version_history_days = 0').run()
  await server.triggerScheduled()
  const markers = await db
    .prepare("SELECT COUNT(*) AS n FROM sync_items WHERE deleted_at IS NOT NULL AND blob_key = ''")
    .first<number>('n')
  process.stdout.write(`${JSON.stringify({ harnessMarkers: markers })}\n`)
}
const otp = async (email: string, code: string): Promise<void> => {
  const db = await server.getD1()
  const normalized = email.trim().toLowerCase()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare('UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0')
    .bind(normalized)
    .run()
  await db
    .prepare(
      'INSERT INTO otp_codes (id, email, code_hash, expires_at, attempts, used, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
    )
    .bind(
      crypto.randomUUID(),
      normalized,
      createHmac('sha256', 'test-otp-hmac-key').update(code).digest('hex'),
      now + 600,
      now
    )
    .run()
  process.stdout.write(`${JSON.stringify({ harnessOtp: true })}\n`)
}
const entitle = async (email: string): Promise<void> => {
  const db = await server.getD1()
  const { meta } = await db
    .prepare(
      `INSERT OR REPLACE INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, expires_at, updated_at)
       SELECT u.id, e.plan, e.status, e.source, e.storage_limit, e.max_file_size, e.max_vaults, e.version_history_days, e.expires_at, e.updated_at
       FROM users u, sync_entitlements e WHERE u.email = ? AND e.user_id = ?`
    )
    .bind(email.trim().toLowerCase(), userId)
    .run()
  process.stdout.write(`${JSON.stringify({ harnessEntitled: meta.changes > 0 })}\n`)
}
// The user's plan allows files up to `bytes` (`entitlements.ts:189`, a 413 above it).
const fileLimit = async (bytes: string): Promise<void> => {
  const db = await server.getD1()
  const { meta } = await db
    .prepare('UPDATE sync_entitlements SET max_file_size = ? WHERE user_id = ?')
    .bind(Number(bytes), userId)
    .run()
  process.stdout.write(`${JSON.stringify({ harnessFileLimit: meta.changes > 0 })}\n`)
}
// A server that lies: gives an account vault an id no client would register.
const renameVault = async (from: string, to: string): Promise<void> => {
  const db = await server.getD1()
  const { meta } = await db
    .prepare('UPDATE sync_vaults SET vault_id = ? WHERE vault_id = ?')
    .bind(to, from)
    .run()
  process.stdout.write(`${JSON.stringify({ harnessRenamed: meta.changes > 0 })}\n`)
}
const lose = async (itemId: string): Promise<void> => {
  const db = await server.getD1()
  const { meta } = await db
    .prepare('DELETE FROM sync_items WHERE user_id = ? AND item_id = ?')
    .bind(userId, itemId)
    .run()
  for (const table of ['crdt_updates', 'crdt_snapshots']) {
    await db
      .prepare(`DELETE FROM ${table} WHERE user_id = ? AND note_id = ?`)
      .bind(userId, itemId)
      .run()
  }
  process.stdout.write(`${JSON.stringify({ harnessLost: meta.changes })}\n`)
}
const policy = async (writesEnabled: string, minWriteVersion?: string): Promise<void> => {
  const db = await server.getD1()
  await db
    .prepare(
      `INSERT INTO client_policies (platform, min_write_version, writes_enabled, updated_at)
       VALUES ('desktop', ?, ?, ?)
       ON CONFLICT (platform) DO UPDATE SET min_write_version = excluded.min_write_version,
         writes_enabled = excluded.writes_enabled, updated_at = excluded.updated_at`
    )
    .bind(minWriteVersion ?? null, Number(writesEnabled), Math.floor(Date.now() / 1000))
    .run()
  process.stdout.write(`${JSON.stringify({ harnessPolicy: true })}\n`)
}
const commands = createInterface({ input: process.stdin })
commands.on('line', (line) => {
  const [command, ...args] = line.trim().split(/\s+/)
  if (command === 'purge') void purge()
  if (command === 'otp' && args.length === 2) void otp(args[0], args[1])
  if (command === 'entitle' && args.length === 1) void entitle(args[0])
  if (command === 'file-limit' && args.length === 1) void fileLimit(args[0])
  if (command === 'rename-vault' && args.length === 2) void renameVault(args[0], args[1])
  if (command === 'lose' && args.length === 1) void lose(args[0])
  if (command === 'policy' && args.length >= 1) void policy(args[0], args[1])
  if (command === 'register') {
    void register(devices.length).then((device) => {
      devices.push(device)
      process.stdout.write(`${JSON.stringify({ harnessDevice: device })}\n`)
    })
  }
})
commands.on('close', () => void stop())
