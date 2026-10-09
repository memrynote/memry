/**
 * #3022: a canvas image whose chunks a peer freed heals before the canvas is
 * pushed, against the REAL sync-server Worker (miniflare, real D1 migrations,
 * real R2, real cron).
 *
 * Two devices share one vault: P and Q each have their own data DB and vault
 * folder, and the real attachment client and canvas asset service. Only the
 * sync of the canvas record itself is played by hand: each push hands the
 * scene the push would send to the other device's apply path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'

// `attachments.ts` imports `net` from electron; fetchFn is injected instead.
vi.mock('electron', () => ({
  net: {
    fetch: () => {
      throw new Error('net.fetch must not be used, this spec injects fetchFn')
    }
  }
}))

import { canvases } from '@memry/db-schema'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'
import { AttachmentSyncService } from '../../sync/attachments'
import {
  recordDeletedItemAssets,
  releaseExpiredDeletedAssets
} from '../../sync/deleted-asset-release'
import { createCanvas, deleteCanvas, updateCanvas } from '../store'
import {
  canvasAssetDiskPath,
  ensureAssetsPresent,
  holdCanvasAssetsForPush,
  injectSceneAssetSidecar,
  reconcileCanvasAssets,
  uploadCanvasAsset,
  type AssetServiceContext
} from './asset-service'
import { dereferenceChunks } from './attachment-dereference'
import { holdCanvasAssetChunks, releaseCanvasAssetHolds, type ChunkHoldDeps } from './chunk-holds'
import { listAssetsByCanvas } from './asset-store'
import { readMemryAssets, sceneWithCurrentAssetRows } from './memry-assets'

type Harness = {
  start(): Promise<void>
  stop(): Promise<void>
  getD1(): Promise<D1Database>
  getDirectUrl(): Promise<URL>
  createAccessToken(userId: string, deviceId: string): Promise<string>
  triggerScheduled(cron?: string): Promise<void>
}

const DAY = 24 * 60 * 60 * 1000
const VAULT_ID = 'default'

let server: Harness
let baseUrl: string
let token: string
let vaultKey: Uint8Array
let signing: { publicKey: Uint8Array; privateKey: Uint8Array }
let deviceId: string
let userId: string
const cleanup: string[] = []

const realFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(input as RequestInfo, init)

async function seedUser(): Promise<void> {
  const db = await server.getD1()
  userId = randomUUID()
  deviceId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, ?, ?, ?)`
    )
    .bind(userId, `${userId}@example.test`, 1024 * 1024 * 1024, now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at
       ) VALUES (?, 'believer', 'active', 'test_seed', ?, ?, NULL, 365, ?)`
    )
    .bind(userId, 1024 * 1024 * 1024, 200 * 1024 * 1024, now)
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
  token = await server.createAccessToken(userId, deviceId)
}

interface Device {
  db: TestDataDb
  vaultPath: string
  ctx: AssetServiceContext
  restoreErrors: number
}

async function device(fetchFn: typeof fetch = realFetch): Promise<Device> {
  const db = createTestDataDb()
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), 'memry-holds-int-'))
  cleanup.push(vaultPath)
  const attachments = new AttachmentSyncService({
    getAccessToken: async () => token,
    // Copies: the client wipes key buffers after use.
    getVaultKey: async () => new Uint8Array(vaultKey),
    getSigningKeys: async () => ({
      secretKey: new Uint8Array(signing.privateKey),
      publicKey: signing.publicKey,
      deviceId
    }),
    getDevicePublicKey: async () => signing.publicKey,
    getSyncServerUrl: () => baseUrl,
    fetchFn: realFetch
  })
  const holdDeps: ChunkHoldDeps = {
    getAccessToken: async () => token,
    getSyncServerUrl: () => baseUrl,
    getVaultId: () => VAULT_ID,
    getVaultKey: async () => new Uint8Array(vaultKey),
    fetchFn
  }
  const dev: Device = {
    db,
    vaultPath,
    restoreErrors: 0,
    ctx: {
      db,
      vaultId: VAULT_ID,
      vaultPath,
      uploadAttachment: (canvasId, filePath) => attachments.uploadAttachment(canvasId, filePath),
      downloadAttachment: async (attachmentId, targetPath) => {
        await attachments.downloadAttachment(attachmentId, targetPath)
      },
      dereference: (chunkHashes) => dereferenceChunks(chunkHashes, holdDeps),
      holdChunks: (canvasId, holds) => holdCanvasAssetChunks(canvasId, holds, holdDeps),
      releaseHolds: (canvasId, hashes) => releaseCanvasAssetHolds(canvasId, hashes, holdDeps),
      markWritebackIgnored: () => {},
      trackEvent: (name) => {
        if (name === 'app_error_seen') dev.restoreErrors++
      }
    }
  }
  return dev
}

/** A new canvas on `dev` showing one externalized image with these bytes. */
async function canvasWithImage(dev: Device, bytes: Uint8Array) {
  const canvas = createCanvas(dev.db, dev.vaultPath, VAULT_ID, { title: 'Board' })
  const { ref, deduped } = await uploadCanvasAsset(dev.ctx, canvas.id, 'file-1', 'image/png', bytes)
  const raw = JSON.stringify({ type: 'excalidraw', files: { 'file-1': { dataURL: ref } } })
  const scene = injectSceneAssetSidecar(dev.ctx, canvas.id, raw)
  expect(updateCanvas(dev.db, dev.vaultPath, canvas.id, { scene }).ok).toBe(true)
  return { id: canvas.id, scene, deduped }
}

/** What the push coordinator does before it sends a canvas, then the scene it sends. */
async function push(dev: Device, canvasId: string, scene: string): Promise<string> {
  expect(await holdCanvasAssetsForPush(dev.ctx, canvasId, scene)).toBe(true)
  return sceneWithCurrentAssetRows(scene, listAssetsByCanvas(dev.db, canvasId))
}

/** The receiving half of a canvas pull: the row, then the asset restore. */
async function apply(dev: Device, canvasId: string, scene: string): Promise<void> {
  const existing = dev.db.select().from(canvases).where(eq(canvases.id, canvasId)).get()
  if (existing) {
    dev.db.update(canvases).set({ deletedAt: null }).where(eq(canvases.id, canvasId)).run()
  } else {
    dev.db
      .insert(canvases)
      .values({
        id: canvasId,
        vaultId: VAULT_ID,
        title: 'Board',
        snapshotCiphertext: '',
        vectorClock: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()
  }
  await ensureAssetsPresent(dev.ctx, canvasId, readMemryAssets(scene))
}

/** P deletes the canvas here and frees its assets once the grace period passed. */
async function deleteAndFree(dev: Device, canvasId: string): Promise<void> {
  expect(await deleteCanvas(dev.db, dev.vaultPath, canvasId, async () => {})).toBe(true)
  recordDeletedItemAssets(dev.db, 'canvas', canvasId)
  const settled = await releaseExpiredDeletedAssets({
    db: dev.db,
    vaultPath: dev.vaultPath,
    now: () => Date.now() + 31 * DAY,
    chunkHashesOf: async () => [],
    dereference: dev.ctx.dereference,
    releaseHolds: dev.ctx.releaseHolds,
    markWritebackIgnored: () => {}
  })
  expect(settled).toBe(1)
  await server.triggerScheduled()
}

async function storedChunks(hashes: string[]): Promise<number> {
  const d1 = await server.getD1()
  let n = 0
  for (const hash of hashes) {
    if (await d1.prepare('SELECT 1 FROM blob_chunks WHERE hash = ?').bind(hash).first()) n++
  }
  return n
}

async function chunkState(hashes: string[]): Promise<{ refs: number; bytes: number }> {
  const d1 = await server.getD1()
  let refs = 0
  let bytes = 0
  for (const hash of hashes) {
    const row = await d1
      .prepare('SELECT ref_count, size_bytes FROM blob_chunks WHERE hash = ?')
      .bind(hash)
      .first<{ ref_count: number; size_bytes: number }>()
    refs += row?.ref_count ?? 0
    bytes += row?.size_bytes ?? 0
  }
  return { refs, bytes }
}

async function storageUsed(): Promise<number> {
  const d1 = await server.getD1()
  return (
    (await d1
      .prepare('SELECT storage_used FROM users WHERE id = ?')
      .bind(userId)
      .first<number>('storage_used')) ?? 0
  )
}

/** An old server: no hold routes, so they answer 404 like any unknown path. */
const oldServerFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  String(input).includes('/attachments/holds')
    ? Promise.resolve(new Response('Not Found', { status: 404 }))
    : realFetch(input, init)) as typeof fetch

async function restoredBytes(dev: Device, scene: string): Promise<Buffer> {
  const [descriptor] = readMemryAssets(scene)
  return readFile(canvasAssetDiskPath(dev.vaultPath, descriptor!.filename))
}

beforeAll(async () => {
  await sodium.ready
  const mod = await import('@memry/sync-harness/simulated-server')
  server = new mod.SimulatedServer() as Harness
  await server.start()
  baseUrl = (await server.getDirectUrl()).origin
}, 180_000)

afterAll(async () => {
  await server?.stop()
})

beforeEach(async () => {
  await seedUser()
  vaultKey = sodium.randombytes_buf(32)
  signing = sodium.crypto_sign_keypair()
})

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('canvas asset chunk holds against the real sync-server (#3022)', () => {
  it('heals an image reused offline after the peer freed its only upload', async () => {
    const p = await device()
    const q = await device()
    const image = new Uint8Array(randomBytes(32 * 1024))

    // P uploads the image on canvas A and syncs A to Q.
    const a = await canvasWithImage(p, image)
    const pushedA = await push(p, a.id, a.scene)
    await apply(q, a.id, pushedA)
    const [original] = readMemryAssets(pushedA)

    // Q, offline, shows the same image on a new canvas B: a dedup hit, no upload.
    const b = await canvasWithImage(q, image)
    expect(b.deduped).toBe(true)

    // P deletes A; 30 days later P frees it and the cron reaps the chunks.
    await deleteAndFree(p, a.id)
    expect(await storedChunks(original!.chunkHashes)).toBe(0)

    // Q comes back online and pushes B; P pulls it.
    const pushedB = await push(q, b.id, b.scene)
    await apply(p, b.id, pushedB)

    expect(p.restoreErrors).toBe(0)
    expect(Buffer.compare(await restoredBytes(p, pushedB), Buffer.from(image))).toBe(0)

    // The hold, not an upload ref, keeps the re-uploaded chunks through the cron.
    const [healed] = readMemryAssets(pushedB)
    await server.triggerScheduled()
    expect(await storedChunks(healed!.chunkHashes)).toBe(healed!.chunkHashes.length)

    // Q drops the image from B: its hold goes, and the cron frees the chunks.
    const emptied = JSON.stringify({ type: 'excalidraw', files: {} })
    await reconcileCanvasAssets(q.ctx, b.id, emptied)
    await server.triggerScheduled()
    expect(await storedChunks(healed!.chunkHashes)).toBe(0)
  })

  it('heals a canvas edited offline that outlived the peer freeing it', async () => {
    const p = await device()
    const q = await device()
    const image = new Uint8Array(randomBytes(32 * 1024))

    const a = await canvasWithImage(p, image)
    const pushedA = await push(p, a.id, a.scene)
    await apply(q, a.id, pushedA)

    // P deletes and frees A while Q edits it offline; Q's edit beats the delete.
    await deleteAndFree(p, a.id)
    const revived = await push(q, a.id, pushedA)
    await apply(p, a.id, revived)

    expect(p.restoreErrors).toBe(0)
    expect(Buffer.compare(await restoredBytes(p, revived), Buffer.from(image))).toBe(0)
  })

  it('frees an image two devices drop at once only after its last hold, and refunds it once', async () => {
    const p = await device()
    const q = await device()
    const image = new Uint8Array(randomBytes(32 * 1024))
    const emptied = JSON.stringify({ type: 'excalidraw', files: {} })

    // P uploads the image on A; Q shows it on B and C too (dedup hits, held).
    const a = await canvasWithImage(p, image)
    const pushedA = await push(p, a.id, a.scene)
    await apply(q, a.id, pushedA)
    const b = await canvasWithImage(q, image)
    const c = await canvasWithImage(q, image)
    expect(b.deduped && c.deduped).toBe(true)
    const pushedB = await push(q, b.id, b.scene)
    const pushedC = await push(q, c.id, c.scene)
    const [asset] = readMemryAssets(pushedB)
    const hashes = asset!.chunkHashes

    // P frees A, its only canvas with the image: the upload ref goes, so only
    // the holds of B and C keep the chunks. Then both devices show B and C.
    await deleteAndFree(p, a.id)
    expect(await chunkState(hashes)).toMatchObject({ refs: 0 })
    expect(await storedChunks(hashes)).toBe(hashes.length)
    await apply(p, b.id, pushedB)
    await apply(p, c.id, pushedC)
    const { bytes } = await chunkState(hashes)
    const charged = await storageUsed()

    // Both drop the image from B at once: C still holds it, so nothing is freed.
    await Promise.all([
      reconcileCanvasAssets(p.ctx, b.id, emptied),
      reconcileCanvasAssets(q.ctx, b.id, emptied)
    ])
    await server.triggerScheduled()
    expect(await storedChunks(hashes)).toBe(hashes.length)
    expect(await storageUsed()).toBe(charged)

    // Both drop it from C at once: the last hold goes, the bytes are refunded
    // once, and the cron reaps the chunks.
    await Promise.all([
      reconcileCanvasAssets(p.ctx, c.id, emptied),
      reconcileCanvasAssets(q.ctx, c.id, emptied)
    ])
    expect(await storageUsed()).toBe(charged - bytes)
    await server.triggerScheduled()
    expect(await storedChunks(hashes)).toBe(0)
  })

  it('pushes and drops images as before against a server without holds', async () => {
    const p = await device(oldServerFetch)
    const q = await device(oldServerFetch)
    const image = new Uint8Array(randomBytes(32 * 1024))

    const a = await canvasWithImage(p, image)
    const pushedA = await push(p, a.id, a.scene)
    await apply(q, a.id, pushedA)
    expect(q.restoreErrors).toBe(0)
    expect(Buffer.compare(await restoredBytes(q, pushedA), Buffer.from(image))).toBe(0)

    // Dropping the image still dereferences the upload, so the cron frees it.
    const [asset] = readMemryAssets(pushedA)
    await reconcileCanvasAssets(p.ctx, a.id, JSON.stringify({ type: 'excalidraw', files: {} }))
    expect(listAssetsByCanvas(p.db, a.id)).toEqual([])
    await server.triggerScheduled()
    expect(await storedChunks(asset!.chunkHashes)).toBe(0)
  })
})
