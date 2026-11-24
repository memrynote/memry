/**
 * #3015: a deleted note or canvas frees its stored assets 30 days after the
 * delete, unless an item this device can see still references them.
 *
 * Real data DB (every drizzle-data migration), the real canvas store and asset
 * service writing real files, and the real dereference client. Only `fetch`
 * behind the client is faked, so each test reads the exact request the server
 * would get.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { canvasAssets, deletedAssetReleases, inboxItems, noteMetadata } from '@memry/db-schema'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { createCanvas, deleteCanvas, updateCanvas } from '../canvas/store'
import {
  reconcileCanvasAssets,
  uploadCanvasAsset,
  type AssetServiceContext
} from '../canvas/assets/asset-service'
import { dereferenceChunks } from '../canvas/assets/attachment-dereference'
import { encrypt, wrapFileKey } from '../crypto/encryption'
import { generateFileKey } from '../crypto/keys'
import { signPayload } from '../crypto/signatures'
import { AttachmentSyncService, type EncryptedAttachmentManifest } from './attachments'
import { recordDeletedItemAssets, releaseExpiredDeletedAssets } from './deleted-asset-release'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() })
}))

const DAY = 24 * 60 * 60 * 1000
const VAULT_ID = 'vault-1'

let db: TestDataDb
let vaultPath: string
let now: number
let serverUp: boolean
let dereferenced: string[][]
let chunkLookups: string[]
let uploads: number

function fetchFn(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!serverUp) return Promise.resolve(new Response('down', { status: 503 }))
  // oxlint-disable-next-line typescript/no-base-to-string -- Y.Text/Y.XmlFragment toString returns the document text; the rule does not see the override
  dereferenced.push((JSON.parse(String(init?.body)) as { chunkHashes: string[] }).chunkHashes)
  return Promise.resolve(Response.json({ dereferenced: 1 }))
}

const dereference = async (chunkHashes: string[]): Promise<{ ok: boolean }> => {
  const { ok } = await dereferenceChunks(chunkHashes, {
    getAccessToken: async () => 'token',
    getSyncServerUrl: () => 'http://sync.test',
    getVaultId: () => VAULT_ID,
    fetchFn: fetchFn
  })
  return { ok }
}

function assetCtx(): AssetServiceContext {
  return {
    db,
    vaultId: VAULT_ID,
    vaultPath,
    uploadAttachment: async () => {
      uploads++
      return {
        attachmentId: `att-${uploads}`,
        manifest: { chunks: [{ encryptedHash: `chunk-${uploads}` }] }
      }
    },
    downloadAttachment: async () => {},
    dereference,
    holdChunks: async () => ({ status: 'ok', missing: new Set() }),
    releaseHolds: async () => ({ ok: true }),
    recordAppWrite: () => () => {},
    trackEvent: () => {}
  }
}

const release = () =>
  releaseExpiredDeletedAssets({
    db,
    vaultPath,
    now: () => now,
    chunkHashesOf: async (attachmentId) => {
      chunkLookups.push(attachmentId)
      return [`chunk-of-${attachmentId}`]
    },
    dereference,
    releaseHolds: async () => ({ ok: true })
  })

/**
 * A sync server holding one signed manifest per id, whose one chunk is
 * `chunk-of-<id>`. `servedAs` maps a requested id to the attachment whose
 * manifest the server answers with instead.
 */
async function manifestServer(ids: string[]) {
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
  await sodium.ready
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
  const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
  const vaultKey = generateFileKey()
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
  const signer = sodium.crypto_sign_keypair()
  const manifests = new Map<string, EncryptedAttachmentManifest>()
  for (const id of ids) {
    const fileKey = generateFileKey()
    const manifest = {
      id,
      filename: `${id}.bin`,
      mimeType: 'application/octet-stream',
      size: 1,
      checksum: '',
      chunks: [{ index: 0, hash: '', encryptedHash: `chunk-of-${id}`, size: 1 }],
      chunkSize: 1,
      createdAt: now
    }
    const body = encrypt(new TextEncoder().encode(JSON.stringify(manifest)), fileKey)
    const key = wrapFileKey(fileKey, vaultKey)
    const signed = {
      encryptedManifest: toB64(body.ciphertext),
      manifestNonce: toB64(body.nonce),
      encryptedFileKey: toB64(key.wrappedKey),
      keyNonce: toB64(key.nonce)
    }
    const signature = signPayload(signed, CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST, signer.privateKey)
    manifests.set(id, { ...signed, manifestSignature: toB64(signature), signerDeviceId: 'd1' })
  }
  const servedAs = new Map<string, string>()
  const service = new AttachmentSyncService({
    getAccessToken: async () => 'token',
    getVaultKey: async () => vaultKey,
    getSigningKeys: async () => ({
      secretKey: signer.privateKey.slice(),
      publicKey: signer.publicKey,
      deviceId: 'd1'
    }),
    getDevicePublicKey: async () => signer.publicKey,
    getSyncServerUrl: () => 'http://sync.test',
    getVaultPath: () => vaultPath,
    fetchFn: async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const id = url.slice('http://sync.test/sync/attachments/'.length, -'/manifest'.length)
      return Response.json(manifests.get(servedAs.get(id) ?? id))
    }
  })
  return { service, servedAs }
}

/** A live canvas whose scene holds one externalized image with these bytes. */
async function canvasWithImage(title: string, bytes: string) {
  const canvas = createCanvas(db, vaultPath, VAULT_ID, { title })
  const { ref } = await uploadCanvasAsset(
    assetCtx(),
    canvas.id,
    'file-1',
    'image/png',
    new TextEncoder().encode(bytes)
  )
  const scene = JSON.stringify({ type: 'excalidraw', files: { 'file-1': { dataURL: ref } } })
  const saved = updateCanvas(db, vaultPath, canvas.id, { scene })
  expect(saved.ok).toBe(true)
  return { id: canvas.id, ref, file: decodeURIComponent(new URL(ref).pathname) }
}

async function deleteCanvasHere(id: string): Promise<void> {
  expect(await deleteCanvas(db, vaultPath, id, async (abs) => fs.rmSync(abs))).toBe(true)
  recordDeletedItemAssets(db, 'canvas', id, now)
}

function insertNote(id: string, attachmentReferences: string[]): void {
  db.insert(noteMetadata)
    .values({
      id,
      path: `${id}.md`,
      title: id,
      attachmentReferences,
      createdAt: new Date(now).toISOString(),
      modifiedAt: new Date(now).toISOString()
    })
    .run()
}

function advance(days: number): void {
  now += days * DAY
  vi.setSystemTime(now)
}

const releaseRows = () => db.select().from(deletedAssetReleases).all()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  now = Date.UTC(2026, 0, 1)
  vi.setSystemTime(now)
  db = createTestDataDb()
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-asset-release-'))
  serverUp = true
  dereferenced = []
  chunkLookups = []
  uploads = 0
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(vaultPath, { recursive: true, force: true })
})

describe('deleted canvas assets', () => {
  it('keeps them for 30 days, then frees the server chunks and the file', async () => {
    const canvas = await canvasWithImage('Board', 'only-here')
    await deleteCanvasHere(canvas.id)

    advance(29)
    expect(await release()).toBe(0)
    expect(dereferenced).toEqual([])
    expect(fs.existsSync(canvas.file)).toBe(true)

    advance(2)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([['chunk-1']])
    expect(fs.existsSync(canvas.file)).toBe(false)
    expect(db.select().from(canvasAssets).all()).toEqual([])
    expect(releaseRows()).toEqual([])

    // Nothing left to free: a later pass sends nothing.
    expect(await release()).toBe(0)
    expect(dereferenced).toHaveLength(1)
  })

  it('keeps an image a live canvas still shows', async () => {
    const deleted = await canvasWithImage('Old', 'shared')
    const live = await canvasWithImage('Live', 'shared')
    await deleteCanvasHere(deleted.id)

    advance(31)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([])
    expect(fs.existsSync(live.file)).toBe(true)
    expect(
      db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, live.id)).all()
    ).toHaveLength(1)
  })

  it('keeps an image a live canvas uploaded but has not saved into its scene yet', async () => {
    const deleted = await canvasWithImage('Old', 'shared')
    await deleteCanvasHere(deleted.id)

    // Pasted near the end of the grace period: dedup puts the row on chunk-1,
    // and the sweep runs before the renderer saves the scene.
    advance(29)
    const live = createCanvas(db, vaultPath, VAULT_ID, { title: 'Live' })
    await uploadCanvasAsset(
      assetCtx(),
      live.id,
      'file-1',
      'image/png',
      new TextEncoder().encode('shared')
    )
    expect(uploads).toBe(1)

    advance(2)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([])
    expect(fs.existsSync(deleted.file)).toBe(true)
    expect(
      db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, live.id)).get()?.chunkHashes
    ).toEqual(['chunk-1'])
  })

  it('keeps the chunk link for an image a canvas restored under a new id still shows', async () => {
    const { id, ref } = await canvasWithImage('Old', 'shared')
    await deleteCanvasHere(id)
    // Restored from the OS trash (#3012): a new id, the same scene, no asset rows.
    const restored = createCanvas(db, vaultPath, VAULT_ID, { title: 'Restored' })
    const scene = JSON.stringify({ type: 'excalidraw', files: { 'file-1': { dataURL: ref } } })
    expect(updateCanvas(db, vaultPath, restored.id, { scene }).ok).toBe(true)

    advance(31)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([])

    // The link moved to the restored canvas, so uploading the image again reuses
    // the stored chunks, and dropping it later frees them instead of leaking them.
    await uploadCanvasAsset(
      assetCtx(),
      restored.id,
      'file-1',
      'image/png',
      new TextEncoder().encode('shared')
    )
    expect(uploads).toBe(1)
    expect(
      db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, restored.id)).get()
        ?.chunkHashes
    ).toEqual(['chunk-1'])
  })

  it('keeps an image another canvas deleted inside the grace period still holds', async () => {
    const first = await canvasWithImage('First', 'shared')
    const second = await canvasWithImage('Second', 'shared')
    await deleteCanvasHere(first.id)
    advance(20)
    await deleteCanvasHere(second.id)

    advance(11)
    await release()
    expect(dereferenced).toEqual([])
    expect(fs.existsSync(second.file)).toBe(true)

    advance(20)
    await release()
    expect(dereferenced).toEqual([['chunk-1']])
    expect(fs.existsSync(second.file)).toBe(false)
  })

  it('retries on a later pass when the server cannot be reached', async () => {
    const canvas = await canvasWithImage('Board', 'only-here')
    await deleteCanvasHere(canvas.id)
    advance(31)

    serverUp = false
    expect(await release()).toBe(0)
    expect(releaseRows()).toHaveLength(1)
    expect(fs.existsSync(canvas.file)).toBe(true)

    serverUp = true
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([['chunk-1']])
  })

  it('frees an image a live board drops once the deleted canvas holding it is past the grace period', async () => {
    const deleted = await canvasWithImage('Old', 'shared')
    const live = await canvasWithImage('Live', 'shared')
    // Deleted on a peer: no release record here, only the tombstone.
    expect(await deleteCanvas(db, vaultPath, deleted.id, async (abs) => fs.rmSync(abs))).toBe(true)

    const emptyScene = JSON.stringify({ type: 'excalidraw', files: {} })
    advance(10)
    await reconcileCanvasAssets(assetCtx(), live.id, emptyScene)
    expect(dereferenced).toEqual([])

    // The peer frees chunk-1 once its grace period ends, so the deleted
    // canvas's row is no dedup source here: the image uploads fresh.
    const later = await canvasWithImage('Later', 'shared')
    advance(21)
    await reconcileCanvasAssets(assetCtx(), later.id, emptyScene)
    expect(dereferenced).toEqual([['chunk-2']])
  })
})

describe('deleted note attachments', () => {
  it('frees the attachments no live note references after 30 days', async () => {
    insertNote('gone', ['a-1', 'a-shared'])
    insertNote('kept', ['a-shared'])
    recordDeletedItemAssets(db, 'note', 'gone', now)
    db.delete(noteMetadata).where(eq(noteMetadata.id, 'gone')).run()

    advance(29)
    await release()
    expect(dereferenced).toEqual([])

    advance(2)
    expect(await release()).toBe(1)
    expect(chunkLookups).toEqual(['a-1'])
    expect(dereferenced).toEqual([['chunk-of-a-1']])
    expect(releaseRows()).toEqual([])
  })

  it('names the attachment whose manifest cannot be read, and retries later', async () => {
    insertNote('gone', ['a-bad'])
    recordDeletedItemAssets(db, 'note', 'gone', now)
    db.delete(noteMetadata).where(eq(noteMetadata.id, 'gone')).run()
    advance(31)

    const settled = await releaseExpiredDeletedAssets({
      db,
      vaultPath,
      now: () => now,
      chunkHashesOf: async () => {
        throw new Error('manifest signer revoked')
      },
      dereference,
      releaseHolds: async () => ({ ok: true })
    })
    expect(settled).toBe(0)
    expect(releaseRows()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attachmentId: 'a-bad' })
    )
  })

  it("frees nothing while the server answers with another attachment's manifest, and retries later (#5664)", async () => {
    const server = await manifestServer(['a-1', 'a-2'])
    server.servedAs.set('a-1', 'a-2')
    insertNote('gone', ['a-1'])
    recordDeletedItemAssets(db, 'note', 'gone', now)
    db.delete(noteMetadata).where(eq(noteMetadata.id, 'gone')).run()
    advance(31)
    const releaseFromServer = () =>
      releaseExpiredDeletedAssets({
        db,
        vaultPath,
        now: () => now,
        chunkHashesOf: (id) => server.service.chunkHashesOf(id),
        dereference,
        releaseHolds: async () => ({ ok: true })
      })

    expect(await releaseFromServer()).toBe(0)
    expect(dereferenced).toEqual([])
    expect(releaseRows()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      attachmentId: 'a-1',
      manifestId: 'a-2'
    })

    server.servedAs.clear()
    expect(await releaseFromServer()).toBe(1)
    expect(dereferenced).toEqual([['chunk-of-a-1']])
    expect(releaseRows()).toEqual([])
  })

  it('frees nothing for a note that is live again', async () => {
    insertNote('back', ['a-1'])
    recordDeletedItemAssets(db, 'note', 'back', now)

    advance(31)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([])
  })
})

describe('deleted inbox item attachments (#4157)', () => {
  function insertInboxItem(id: string, values: Partial<typeof inboxItems.$inferInsert> = {}): void {
    db.insert(inboxItems)
      .values({ id, type: 'image', title: id, ...values })
      .run()
  }

  it('frees the blob of an unfiled item 30 days after its permanent delete', async () => {
    insertInboxItem('photo', { attachmentId: 'att-photo' })
    recordDeletedItemAssets(db, 'inbox', 'photo', now)
    db.delete(inboxItems).where(eq(inboxItems.id, 'photo')).run()

    advance(29)
    expect(await release()).toBe(0)
    expect(dereferenced).toEqual([])

    advance(2)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([['chunk-of-att-photo']])
    expect(releaseRows()).toEqual([])
  })

  it('keeps the blob when a note reused it', async () => {
    insertInboxItem('photo', { attachmentId: 'att-photo' })
    recordDeletedItemAssets(db, 'inbox', 'photo', now)
    db.delete(inboxItems).where(eq(inboxItems.id, 'photo')).run()
    insertNote('note-with-photo', ['att-photo'])

    advance(31)
    expect(await release()).toBe(1)

    expect(dereferenced).toEqual([])
    expect(chunkLookups).toEqual([])
  })

  it('records nothing for a filed item or one that never uploaded', () => {
    insertInboxItem('filed', { attachmentId: 'att-1', filedAt: '2026-01-01T00:00:00.000Z' })
    insertInboxItem('local')

    recordDeletedItemAssets(db, 'inbox', 'filed', now)
    recordDeletedItemAssets(db, 'inbox', 'local', now)

    expect(releaseRows()).toEqual([])
  })
})
