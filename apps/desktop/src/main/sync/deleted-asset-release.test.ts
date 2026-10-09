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
import { canvasAssets, deletedAssetReleases, noteMetadata } from '@memry/db-schema'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { createCanvas, deleteCanvas, updateCanvas } from '../canvas/store'
import {
  reconcileCanvasAssets,
  uploadCanvasAsset,
  type AssetServiceContext
} from '../canvas/assets/asset-service'
import { dereferenceChunks } from '../canvas/assets/attachment-dereference'
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
  dereferenced.push((JSON.parse(String(init?.body)) as { chunkHashes: string[] }).chunkHashes)
  return Promise.resolve(Response.json({ dereferenced: 1 }))
}

const dereference = async (chunkHashes: string[]): Promise<{ ok: boolean }> => {
  const { ok } = await dereferenceChunks(chunkHashes, {
    getAccessToken: async () => 'token',
    getSyncServerUrl: () => 'http://sync.test',
    getVaultId: () => VAULT_ID,
    fetchFn: fetchFn as typeof fetch
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
    markWritebackIgnored: () => {},
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
    markWritebackIgnored: () => {}
  })

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

    // The restored canvas uploads the image again: it reuses the stored chunks,
    // so dropping it later frees them instead of leaking them.
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

    const later = await canvasWithImage('Later', 'shared')
    advance(21)
    await reconcileCanvasAssets(assetCtx(), later.id, emptyScene)
    expect(dereferenced).toEqual([['chunk-1']])
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
      markWritebackIgnored: () => {}
    })
    expect(settled).toBe(0)
    expect(releaseRows()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attachmentId: 'a-bad' })
    )
  })

  it('frees nothing for a note that is live again', async () => {
    insertNote('back', ['a-1'])
    recordDeletedItemAssets(db, 'note', 'back', now)

    advance(31)
    expect(await release()).toBe(1)
    expect(dereferenced).toEqual([])
  })
})
