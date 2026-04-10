import sodium from 'libsodium-wrappers-sumo'
import { SignJWT } from 'jose'
import { ARGON2_PARAMS } from '@memry/contracts/crypto'

const KEY_VERIFIER_CONTEXT = 'memrykve'
const KEY_VERIFIER_ID = 4
const MASTER_KEY_LENGTH = 32

interface TestSyncServer {
  start(): Promise<void>
  stop(): Promise<void>
  getD1(): Promise<D1Database>
  getDirectUrl(): Promise<URL>
  getKeys(): { privateKey: CryptoKey; privateKeyPem: string }
}

interface SyncTestDeviceBootstrap {
  email: string
  setupToken: string
  masterKeyBase64: string
  signingSecretKeyBase64: string
  kdfSalt: string
  keyVerifier: string
  skipSetup: boolean
}

export interface SharedSyncBootstrap {
  server: TestSyncServer
  serverUrl: string
  email: string
  deviceA: SyncTestDeviceBootstrap
  deviceB: SyncTestDeviceBootstrap
}

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
}

async function signSetupToken(userId: string, privateKey: CryptoKey): Promise<string> {
  return new SignJWT({
    sub: userId,
    type: 'setup',
    jti: crypto.randomUUID()
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer('memry-sync')
    .setAudience('memry-client')
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function createSharedUser(server: TestSyncServer, email: string): Promise<string> {
  const db = await server.getD1()
  const userId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 5368709120, ?, ?)`
    )
    .bind(userId, email, now, now)
    .run()

  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()

  return userId
}

export async function startSharedSyncBootstrap(): Promise<SharedSyncBootstrap> {
  await sodium.ready

  const { SimulatedServer } =
    await import('../../../../../tests/sync-harness/src/simulated-server.ts')

  const server = new SimulatedServer()
  await server.start()

  const serverUrl = (await server.getDirectUrl()).toString().replace(/\/$/, '')
  const email = `e2e-${crypto.randomUUID()}@memry.local`
  const userId = await createSharedUser(server, email)
  const masterKey = sodium.randombytes_buf(MASTER_KEY_LENGTH)
  const kdfSaltBytes = sodium.randombytes_buf(ARGON2_PARAMS.SALT_LENGTH)
  const keyVerifierBytes = sodium.crypto_kdf_derive_from_key(
    MASTER_KEY_LENGTH,
    KEY_VERIFIER_ID,
    KEY_VERIFIER_CONTEXT,
    masterKey
  )
  const keyVerifier = toBase64(keyVerifierBytes)
  const kdfSalt = toBase64(kdfSaltBytes)
  const setupTokenA = await signSetupToken(userId, server.getKeys().privateKey)
  const setupTokenB = await signSetupToken(userId, server.getKeys().privateKey)
  const signingKeyPairA = sodium.crypto_sign_keypair()
  const signingKeyPairB = sodium.crypto_sign_keypair()

  return {
    server,
    serverUrl,
    email,
    deviceA: {
      email,
      setupToken: setupTokenA,
      masterKeyBase64: toBase64(masterKey),
      signingSecretKeyBase64: toBase64(signingKeyPairA.privateKey),
      kdfSalt,
      keyVerifier,
      skipSetup: false
    },
    deviceB: {
      email,
      setupToken: setupTokenB,
      masterKeyBase64: toBase64(masterKey),
      signingSecretKeyBase64: toBase64(signingKeyPairB.privateKey),
      kdfSalt,
      keyVerifier,
      skipSetup: true
    }
  }
}
