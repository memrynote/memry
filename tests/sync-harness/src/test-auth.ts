import sodium from 'libsodium-wrappers-sumo'
import type { SimulatedServer } from './simulated-server.js'
import type { DeviceIdentity } from './types.js'
import { generateSigningKeypair, generateVaultKey, initCrypto } from './crypto.js'

/**
 * Creates a user + device directly in D1, bypassing OTP/email flow.
 * Returns a DeviceIdentity ready for push/pull operations.
 */
export async function createTestDevice(
  server: SimulatedServer,
  opts: {
    userId?: string
    deviceName?: string
    vaultKey?: Uint8Array
  } = {}
): Promise<DeviceIdentity> {
  await initCrypto()

  const db = await server.getD1()
  const userId = opts.userId ?? crypto.randomUUID()
  const deviceId = crypto.randomUUID()
  const deviceName = opts.deviceName ?? `test-device-${deviceId.slice(0, 8)}`
  const vaultKey = opts.vaultKey ?? generateVaultKey()
  const { publicKey, secretKey } = generateSigningKeypair()

  const authPublicKeyBase64 = sodium.to_base64(
    publicKey,
    sodium.base64_variants.ORIGINAL
  )

  const now = Math.floor(Date.now() / 1000)

  const existingUser = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first()

  if (!existingUser) {
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, ?, 1, 'otp', 0, 5368709120, ?, ?)`
      )
      .bind(userId, `test-${userId.slice(0, 8)}@harness.local`, now, now)
      .run()

    await db
      .prepare(
        `INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)`
      )
      .bind(userId)
      .run()
  }

  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, ?, 'test', '0.1.0', ?, ?, ?)`
    )
    .bind(deviceId, userId, deviceName, authPublicKeyBase64, now, now)
    .run()

  const accessToken = await server.createAccessToken(userId, deviceId)

  return {
    deviceId,
    userId,
    signingPublicKey: publicKey,
    signingSecretKey: secretKey,
    authPublicKeyBase64,
    vaultKey,
    accessToken
  }
}
