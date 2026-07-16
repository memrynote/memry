/**
 * Attachment upload/download against a REAL sync-server.
 *
 * Every other attachment test on both sides mocks the seam: the desktop suite
 * mocks `fetch` wholesale and the sync-server suite mocks R2/D1 with
 * self-consistent numbers. Both stayed green for 58 days while chunked upload
 * was 413ing in production, because nothing exercised client and server
 * together. This spec boots the real Worker (miniflare + real D1 migrations +
 * real R2) and drives the real client against it, so the size accounting, the
 * route prefix and the plan gates are all checked for real.
 *
 * No Electron and no display server needed — `fetchFn` is injected, so the
 * `net` import is never dereferenced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'

// `attachments.ts` imports `net` from electron at module scope. This spec injects
// `fetchFn`, so `net` is never dereferenced — stub the import so the suite runs on a
// plain Node worker (no Electron binary, no display server).
vi.mock('electron', () => ({
  net: {
    fetch: () => {
      throw new Error('net.fetch must not be used — this spec injects fetchFn')
    }
  }
}))

import { AttachmentSyncService, type AttachmentSyncDeps } from './attachments'

const MIB = 1024 * 1024
// nonce(24) + Poly1305 tag(16) — mirrors the server's CHUNK_CRYPTO_OVERHEAD.
const CHUNK_CRYPTO_OVERHEAD = 40

// Mirrors the harness usage in apps/desktop/tests/e2e/utils/sync-backend.ts.
type Harness = {
  start(): Promise<void>
  stop(): Promise<void>
  getD1(): Promise<D1Database>
  getDirectUrl(): Promise<URL>
  createAccessToken(userId: string, deviceId: string): Promise<string>
}

let server: Harness
let baseUrl: string
let tmpDir: string

interface SeededUser {
  userId: string
  deviceId: string
  token: string
}

async function seedUser(opts: {
  plan: string
  status: string
  maxFileSize: number
  storageLimit: number
}): Promise<SeededUser> {
  const db = await server.getD1()
  const userId = randomUUID()
  const deviceId = randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, ?, ?, ?)`
    )
    .bind(userId, `${userId}@example.test`, opts.storageLimit, now, now)
    .run()

  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at
       ) VALUES (?, ?, ?, 'test_seed', ?, ?, NULL, 365, ?)`
    )
    .bind(userId, opts.plan, opts.status, opts.storageLimit, opts.maxFileSize, now)
    .run()

  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, ?, 'test-device', 'test', '99.0.0', ?, 'default', ?, ?)`
    )
    .bind(deviceId, userId, `pubkey-${deviceId}`, now, now)
    .run()

  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()

  const token = await server.createAccessToken(userId, deviceId)
  return { userId, deviceId, token }
}

/**
 * Real client deps. The signing keypair is shared with `getDevicePublicKey` so
 * the manifest signature verifies on the download side.
 */
function createDeps(user: SeededUser): AttachmentSyncDeps {
  const signing = sodium.crypto_sign_keypair()
  const vaultKey = sodium.randombytes_buf(32)

  return {
    getAccessToken: async () => user.token,
    getVaultKey: async () => vaultKey,
    getSigningKeys: async () => ({
      secretKey: signing.privateKey,
      publicKey: signing.publicKey,
      deviceId: user.deviceId
    }),
    getDevicePublicKey: async () => signing.publicKey,
    getSyncServerUrl: () => baseUrl,
    // Real HTTP against the miniflare listener — not a mock.
    fetchFn: (input, init) => fetch(input as RequestInfo, init as RequestInit)
  }
}

async function writeTempFile(name: string, bytes: Uint8Array): Promise<string> {
  const p = path.join(tmpDir, name)
  await writeFile(p, bytes)
  return p
}

beforeAll(async () => {
  await sodium.ready
  const mod = await import('../../../../../tests/sync-harness/src/simulated-server.ts')
  server = new mod.SimulatedServer() as Harness
  await server.start()
  const url = await server.getDirectUrl()
  // origin, not href: href carries a trailing slash and the client appends '/sync/...'.
  baseUrl = url.origin
}, 180_000)

afterAll(async () => {
  await server?.stop()
})

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-attach-int-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('attachment upload/download against the real sync-server', () => {
  it('round-trips a single-chunk file with identical bytes', async () => {
    const user = await seedUser({
      plan: 'believer',
      status: 'active',
      maxFileSize: 200 * MIB,
      storageLimit: 50 * 1024 * MIB
    })
    const svc = new AttachmentSyncService(createDeps(user))

    const original = randomBytes(64 * 1024)
    const src = await writeTempFile('small.bin', original)

    const result = await svc.uploadAttachment('note-1', src)
    expect(result.manifest.chunks).toHaveLength(1)

    const dest = path.join(tmpDir, 'small-out.bin')
    const download = await svc.downloadAttachment(result.attachmentId, dest)

    const roundTripped = await import('node:fs/promises').then((fs) => fs.readFile(dest))
    expect(Buffer.compare(roundTripped, original)).toBe(0)
    expect(download.manifest.size).toBe(original.length)
  }, 120_000)

  it('round-trips a multi-chunk file (>8 MiB) with identical bytes', async () => {
    const user = await seedUser({
      plan: 'believer',
      status: 'active',
      maxFileSize: 200 * MIB,
      storageLimit: 50 * 1024 * MIB
    })
    const svc = new AttachmentSyncService(createDeps(user))

    // 20 MiB => 3 chunks at CHUNK_SIZE = 8 MiB. Each chunk adds nonce(24)+tag(16),
    // so the ciphertext on the wire is 120 bytes larger than the plaintext.
    const original = randomBytes(20 * MIB)
    const src = await writeTempFile('big.bin', original)

    const result = await svc.uploadAttachment('note-2', src)
    expect(result.manifest.chunks).toHaveLength(3)

    const dest = path.join(tmpDir, 'big-out.bin')
    await svc.downloadAttachment(result.attachmentId, dest)

    const roundTripped = await import('node:fs/promises').then((fs) => fs.readFile(dest))
    expect(Buffer.compare(roundTripped, original)).toBe(0)
  }, 180_000)

  it('accepts a Plus-plan file at exactly the 5 MiB limit', async () => {
    const user = await seedUser({
      plan: 'plus',
      status: 'active',
      maxFileSize: 5 * MIB,
      storageLimit: 50 * 1024 * MIB
    })
    const svc = new AttachmentSyncService(createDeps(user))

    // Exactly at the limit. This is the regression that the 58-day bug caused:
    // the encrypted bytes exceed the plaintext, so a naive server that measures
    // ciphertext against the plan limit rejects a legal file.
    const original = randomBytes(5 * MIB)
    const src = await writeTempFile('exact.bin', original)

    const result = await svc.uploadAttachment('note-3', src)
    expect(result.manifest.size).toBe(5 * MIB)

    const dest = path.join(tmpDir, 'exact-out.bin')
    await svc.downloadAttachment(result.attachmentId, dest)
    const roundTripped = await import('node:fs/promises').then((fs) => fs.readFile(dest))
    expect(Buffer.compare(roundTripped, original)).toBe(0)
  }, 180_000)

  it('rejects an over-limit file on a Plus plan with a file-too-large error', async () => {
    const user = await seedUser({
      plan: 'plus',
      status: 'active',
      maxFileSize: 5 * MIB,
      storageLimit: 50 * 1024 * MIB
    })
    const svc = new AttachmentSyncService(createDeps(user))

    const src = await writeTempFile('over.bin', randomBytes(6 * MIB))

    await expect(svc.uploadAttachment('note-4', src)).rejects.toThrow(/plan file size limit/i)
  }, 120_000)

  it('rejects upload on a free plan with payment required', async () => {
    const user = await seedUser({
      plan: 'free',
      status: 'inactive',
      maxFileSize: 0,
      storageLimit: 0
    })
    const svc = new AttachmentSyncService(createDeps(user))

    const src = await writeTempFile('free.bin', randomBytes(1024))

    await expect(svc.uploadAttachment('note-5', src)).rejects.toThrow()
  }, 120_000)

  it('declares the exact encrypted byte total on initiate', async () => {
    // The server can derive this, but only by assuming today's chunk framing.
    // Declaring it explicitly keeps quota accounting correct if the client's
    // cipher or chunking ever changes, and the server validates it for
    // plausibility rather than trusting it.
    const user = await seedUser({
      plan: 'believer',
      status: 'active',
      maxFileSize: 200 * MIB,
      storageLimit: 50 * 1024 * MIB
    })

    let initiateBody: Record<string, unknown> | null = null
    const deps = createDeps(user)
    const realFetch = deps.fetchFn!
    deps.fetchFn = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.endsWith('/sync/attachments/upload/initiate') && typeof init?.body === 'string') {
        initiateBody = JSON.parse(init.body) as Record<string, unknown>
      }
      return realFetch(input, init)
    }

    const svc = new AttachmentSyncService(deps)
    const original = randomBytes(20 * MIB)
    const src = await writeTempFile('declared.bin', original)
    const result = await svc.uploadAttachment('note-6', src)

    const onWire = result.manifest.chunks.reduce(
      (sum, c) => sum + c.size + CHUNK_CRYPTO_OVERHEAD,
      0
    )
    expect(initiateBody).not.toBeNull()
    expect(initiateBody!.totalSize).toBe(20 * MIB)
    expect(initiateBody!.encryptedSize).toBe(onWire)

    // ...and the server charged storage against the ciphertext, not the
    // plaintext. This is the property the 58-day bug violated: the wire bytes
    // exceed `totalSize`, so accounting on `totalSize` under-counts quota and
    // makes the chunk guard reject a legal upload.
    const db = await server.getD1()
    const row = await db
      .prepare('SELECT storage_used FROM users WHERE id = ?')
      .bind(user.userId)
      .first<{ storage_used: number }>()
    expect(row!.storage_used).toBeGreaterThanOrEqual(onWire)
    expect(row!.storage_used).toBeGreaterThan(20 * MIB)
  }, 180_000)

  it('talks to the real /sync route prefix', async () => {
    // The mocked suite matches with `urlStr.includes(path)`, which passes for a
    // wrong base path too. Assert the real mount (index.ts: app.route('/sync', blob)).
    const user = await seedUser({
      plan: 'believer',
      status: 'active',
      maxFileSize: 200 * MIB,
      storageLimit: 50 * 1024 * MIB
    })

    const resp = await fetch(`${baseUrl}/sync/attachments/upload/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: randomUUID(),
        filename: 'probe.bin',
        totalSize: 1024,
        chunkCount: 1
      })
    })
    expect(resp.status).toBe(201)

    // ...and that the un-prefixed path is NOT a route.
    const unprefixed = await fetch(`${baseUrl}/attachments/upload/initiate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attachmentId: randomUUID(),
        filename: 'probe.bin',
        totalSize: 1024,
        chunkCount: 1
      })
    })
    expect(unprefixed.status).toBe(404)
  }, 120_000)
})
