/**
 * The real Worker on miniflare (`SimulatedServer`: D1 migrations, R2, Durable Objects) for a
 * client outside Node, such as the Rust core's harness tests
 * (`crates/memry-desktop/tests/sync_harness.rs`).
 *
 * It registers one user with `DEVICES` devices (default 2), prints one JSON line on stdout,
 * `{ url, userId, devices: [{ deviceId, accessToken, signingSecretKey }] }` (the key as
 * base64, libsodium's 64-byte form), and serves until stdin closes.
 *
 * A `purge` line on stdin ends the user's retention (`version_history_days` 0, as for a user with
 * no entitlement row) and runs the Worker's cron, whose `cleanupExpiredTombstones` sheds every
 * tombstone from an earlier second to a marker (chapter 05 §5.12.3). It answers
 * `{ harnessMarkers }`, the marker count, on stdout.
 */
import { createInterface } from 'node:readline'
import { base64_variants, to_base64 } from 'libsodium-wrappers-sumo'
import { SimulatedServer } from '../src/simulated-server.js'
import { createTestDevice } from '../src/test-auth.js'

const count = Number(process.env.DEVICES ?? '2')
const server = new SimulatedServer()
await server.start()

const userId = crypto.randomUUID()
const devices = []
for (let at = 0; at < count; at += 1) {
  const device = await createTestDevice(server, { userId, deviceName: `harness-${at}` })
  devices.push({
    deviceId: device.deviceId,
    accessToken: device.accessToken,
    signingSecretKey: to_base64(device.signingSecretKey, base64_variants.ORIGINAL)
  })
}

const url = (await server.getDirectUrl()).toString().replace(/\/$/, '')
process.stdout.write(`${JSON.stringify({ url, userId, devices })}\n`)

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
const commands = createInterface({ input: process.stdin })
commands.on('line', (line) => {
  if (line.trim() === 'purge') void purge()
})
commands.on('close', () => void stop())
