/**
 * The real Worker on miniflare (`SimulatedServer`: D1 migrations, R2, Durable Objects) for a
 * client outside Node, such as the Rust core's harness tests
 * (`crates/memry-desktop/tests/sync_harness.rs`).
 *
 * It registers one user with `DEVICES` devices (default 2), prints one JSON line on stdout,
 * `{ url, userId, devices: [{ deviceId, accessToken, signingSecretKey }] }` (the key as
 * base64, libsodium's 64-byte form), and serves until stdin closes.
 */
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
process.stdin.on('end', () => void stop())
process.stdin.on('close', () => void stop())
process.stdin.resume()
