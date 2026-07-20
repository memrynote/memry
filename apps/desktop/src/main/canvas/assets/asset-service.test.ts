import { describe, beforeEach, afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'

import {
  ensureAssetsPresent,
  reconcileCanvasAssets,
  uploadCanvasAsset,
  canvasAssetDiskPath,
  type AssetServiceContext,
  type AssetUploadResult
} from './asset-service'
import { listAssetsByCanvas, recordAsset } from './asset-store'
import { hashAssetContent, assetFilename } from './content-hash'

const MIGRATION_FILES = ['0035_spatial_canvas.sql', '0036_canvas_assets.sql']

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const file of MIGRATION_FILES) {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'database', 'drizzle-data', file),
      'utf8'
    )
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  return drizzle(sqlite, { schema })
}

function insertCanvas(db: ReturnType<typeof freshDb>, id: string, vaultId: string) {
  db.insert(schema.canvases)
    .values({
      id,
      vaultId,
      title: null,
      snapshotCiphertext: 'ciphertext',
      vectorClock: {},
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()
}

/** A scene JSON whose only externalized file points at the given content hash. */
function sceneWithHashes(hashes: string[]): string {
  const files: Record<string, { dataURL: string }> = {}
  hashes.forEach((hash, i) => {
    files[`file-${i}`] = {
      dataURL: `memry-file://local/x/attachments/canvas-assets/${hash}.png`
    }
  })
  return JSON.stringify({ type: 'excalidraw', files })
}

describe('canvas asset service', () => {
  let db: ReturnType<typeof freshDb>
  let vaultPath: string
  let uploadAttachment: ReturnType<typeof vi.fn>
  let downloadAttachment: ReturnType<typeof vi.fn>
  let dereference: ReturnType<typeof vi.fn>
  let markWritebackIgnored: ReturnType<typeof vi.fn>
  let trackEvent: ReturnType<typeof vi.fn>
  let ctx: AssetServiceContext

  beforeEach(() => {
    db = freshDb()
    insertCanvas(db, 'canvas-a', 'vault-1')
    insertCanvas(db, 'canvas-b', 'vault-1')
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-assets-'))

    let counter = 0
    uploadAttachment = vi.fn(
      async (): Promise<AssetUploadResult> => ({
        attachmentId: `attachment-${++counter}`,
        manifest: {
          chunks: [{ encryptedHash: `enc-${counter}-0` }, { encryptedHash: `enc-${counter}-1` }]
        }
      })
    )
    downloadAttachment = vi.fn(async (_attachmentId: string, targetPath: string) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.writeFileSync(targetPath, Buffer.from('downloaded'))
    })
    dereference = vi.fn(async () => {})
    markWritebackIgnored = vi.fn()
    trackEvent = vi.fn()

    ctx = {
      db,
      vaultId: 'vault-1',
      vaultPath,
      uploadAttachment,
      downloadAttachment,
      dereference,
      markWritebackIgnored,
      trackEvent
    }
  })

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  describe('uploadCanvasAsset', () => {
    it('uploads a new asset: calls the upload fn once and records chunkHashes from the manifest', async () => {
      const bytes = Buffer.from('the-image-bytes')
      const res = await uploadCanvasAsset(ctx, 'canvas-a', 'file-1', 'image/png', bytes)

      expect(res.deduped).toBe(false)
      expect(uploadAttachment).toHaveBeenCalledTimes(1)
      expect(res.descriptor.chunkHashes).toEqual(['enc-1-0', 'enc-1-1'])
      expect(res.descriptor.attachmentId).toBe('attachment-1')

      const rows = listAssetsByCanvas(db, 'canvas-a')
      expect(rows).toHaveLength(1)
      expect(rows[0].chunkHashes).toEqual(['enc-1-0', 'enc-1-1'])
      expect(rows[0].sizeBytes).toBe(bytes.length)

      // File materialized on disk under the content-addressed store.
      const diskPath = canvasAssetDiskPath(
        vaultPath,
        assetFilename(hashAssetContent(bytes), 'image/png')
      )
      expect(fs.existsSync(diskPath)).toBe(true)
      expect(markWritebackIgnored).toHaveBeenCalledWith(diskPath)

      expect(trackEvent).toHaveBeenCalledWith(
        'canvas_asset_uploaded',
        expect.objectContaining({ metrics: { byteCount: bytes.length } })
      )
    })

    it('dedup hit: a second upload of identical bytes reuses the attachment and does not re-upload', async () => {
      const bytes = Buffer.from('shared-image-bytes')
      const first = await uploadCanvasAsset(ctx, 'canvas-a', 'file-1', 'image/png', bytes)
      const second = await uploadCanvasAsset(ctx, 'canvas-b', 'file-9', 'image/png', bytes)

      expect(first.deduped).toBe(false)
      expect(second.deduped).toBe(true)
      // The upload fn ran only for the first upload.
      expect(uploadAttachment).toHaveBeenCalledTimes(1)
      expect(second.descriptor.attachmentId).toBe(first.descriptor.attachmentId)
      expect(second.ref).toBe(first.ref)
      expect(second.descriptor.chunkHashes).toEqual(first.descriptor.chunkHashes)

      // Both canvases now have their own dedup/GC row for the shared content.
      expect(listAssetsByCanvas(db, 'canvas-a')).toHaveLength(1)
      expect(listAssetsByCanvas(db, 'canvas-b')).toHaveLength(1)

      expect(trackEvent).toHaveBeenCalledWith(
        'canvas_asset_dedup_hit',
        expect.objectContaining({ metrics: { byteCount: bytes.length } })
      )
    })

    it('dedup hit: resolves ref/path/filename from the RECORDED filename, not the locally-computed one', async () => {
      const bytes = Buffer.from('mismatched-extension-bytes')
      const contentHash = hashAssetContent(bytes)
      const recordedFilename = `${contentHash}.png`

      // Pre-seed a row recorded under .png (e.g. first upload declared image/png).
      recordAsset(db, {
        vaultId: 'vault-1',
        canvasId: 'canvas-a',
        contentHash,
        attachmentId: 'attachment-seed',
        fileId: 'file-seed',
        filename: recordedFilename,
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        chunkHashes: ['chunk-seed'],
        createdAt: 1700000000000
      })

      // This upload declares a DIFFERENT mimeType for the same bytes, so the
      // locally-computed filename (.webp) diverges from the recorded one (.png).
      const res = await uploadCanvasAsset(ctx, 'canvas-b', 'file-2', 'image/webp', bytes)

      expect(res.deduped).toBe(true)
      expect(uploadAttachment).not.toHaveBeenCalled()
      expect(res.descriptor.filename).toBe(recordedFilename)
      expect(res.descriptor.attachmentId).toBe('attachment-seed')

      const recordedDiskPath = canvasAssetDiskPath(vaultPath, recordedFilename)
      const staleDiskPath = canvasAssetDiskPath(vaultPath, `${contentHash}.webp`)
      expect(res.ref.endsWith(recordedFilename)).toBe(true)
      expect(res.ref).not.toContain('.webp')

      // The file materializes at the RECORDED path, never at the locally-computed one.
      expect(fs.existsSync(recordedDiskPath)).toBe(true)
      expect(fs.existsSync(staleDiskPath)).toBe(false)
    })
  })

  describe('reconcileCanvasAssets', () => {
    function seedRow(canvasId: string, contentHash: string, chunk: string) {
      recordAsset(db, {
        vaultId: 'vault-1',
        canvasId,
        contentHash,
        attachmentId: `att-${contentHash}`,
        fileId: `fid-${contentHash}`,
        filename: `${contentHash}.png`,
        mimeType: 'image/png',
        sizeBytes: 10,
        chunkHashes: [chunk],
        createdAt: 1700000000000
      })
    }

    it('dereferences only assets no other canvas references and prunes the removed rows', async () => {
      // canvas-a references hashA (shared), hashB (unique), hashC (shared).
      seedRow('canvas-a', 'hashA', 'chunkA')
      seedRow('canvas-a', 'hashB', 'chunkB')
      seedRow('canvas-a', 'hashC', 'chunkC')
      // canvas-b also references hashA and hashC.
      seedRow('canvas-b', 'hashA', 'chunkA')
      seedRow('canvas-b', 'hashC', 'chunkC')

      // Write the on-disk files so the safe-unlink path can be exercised.
      const dir = path.join(vaultPath, 'attachments', 'canvas-assets')
      fs.mkdirSync(dir, { recursive: true })
      for (const h of ['hashA', 'hashB', 'hashC']) {
        fs.writeFileSync(path.join(dir, `${h}.png`), Buffer.from(h))
      }

      // The saved scene keeps only hashA.
      await reconcileCanvasAssets(ctx, 'canvas-a', sceneWithHashes(['hashA']))

      // Only hashB (referenced by nobody else) is dereferenced.
      expect(dereference).toHaveBeenCalledTimes(1)
      expect(dereference).toHaveBeenCalledWith(['chunkB'])

      // canvas-a keeps hashA; hashB + hashC rows pruned.
      expect(listAssetsByCanvas(db, 'canvas-a').map((r) => r.contentHash)).toEqual(['hashA'])
      // canvas-b untouched.
      expect(
        listAssetsByCanvas(db, 'canvas-b')
          .map((r) => r.contentHash)
          .sort()
      ).toEqual(['hashA', 'hashC'])

      // Safe unlink: hashB's file removed (orphan); hashA (kept) and hashC
      // (shared with canvas-b) stay on disk.
      expect(fs.existsSync(path.join(dir, 'hashB.png'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'hashA.png'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'hashC.png'))).toBe(true)

      expect(trackEvent).toHaveBeenCalledWith(
        'canvas_asset_gc_reaped',
        expect.objectContaining({ metrics: { itemCount: 2 } })
      )
    })

    it('is a no-op when the scene still references every recorded asset', async () => {
      seedRow('canvas-a', 'hashA', 'chunkA')
      await reconcileCanvasAssets(ctx, 'canvas-a', sceneWithHashes(['hashA']))
      expect(dereference).not.toHaveBeenCalled()
      expect(listAssetsByCanvas(db, 'canvas-a')).toHaveLength(1)
    })
  })

  describe('ensureAssetsPresent', () => {
    function descriptor(overrides: Partial<MemryAssetDescriptor>): MemryAssetDescriptor {
      return {
        fileId: 'fid',
        attachmentId: 'att',
        contentHash: 'hash',
        chunkHashes: ['chunk'],
        mimeType: 'image/png',
        sizeBytes: 10,
        filename: 'hash.png',
        ...overrides
      }
    }

    it('downloads only missing files, marks writeback ignored first, and survives a failed download', async () => {
      const present = descriptor({
        contentHash: 'present',
        filename: 'present.png',
        attachmentId: 'a-present'
      })
      const missing = descriptor({
        contentHash: 'missing',
        filename: 'missing.png',
        attachmentId: 'a-missing'
      })
      const failing = descriptor({
        contentHash: 'failing',
        filename: 'failing.png',
        attachmentId: 'a-failing'
      })

      // Pre-create the "present" file so it is skipped.
      const presentPath = canvasAssetDiskPath(vaultPath, 'present.png')
      fs.mkdirSync(path.dirname(presentPath), { recursive: true })
      fs.writeFileSync(presentPath, Buffer.from('already-here'))

      downloadAttachment.mockImplementation(async (attachmentId: string, targetPath: string) => {
        if (attachmentId === 'a-failing') throw new Error('network down')
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.writeFileSync(targetPath, Buffer.from('downloaded'))
      })

      await ensureAssetsPresent(ctx, 'canvas-a', [present, missing, failing])

      // Only the two missing files were attempted.
      expect(downloadAttachment).toHaveBeenCalledTimes(2)
      expect(downloadAttachment).toHaveBeenCalledWith(
        'a-missing',
        canvasAssetDiskPath(vaultPath, 'missing.png')
      )
      expect(downloadAttachment).toHaveBeenCalledWith(
        'a-failing',
        canvasAssetDiskPath(vaultPath, 'failing.png')
      )

      // markWritebackIgnored precedes each download.
      const firstMark = markWritebackIgnored.mock.invocationCallOrder[0]
      const firstDownload = downloadAttachment.mock.invocationCallOrder[0]
      expect(firstMark).toBeLessThan(firstDownload)

      // The successful download recorded a local row; the failure did not abort it.
      const rows = listAssetsByCanvas(db, 'canvas-a').map((r) => r.contentHash)
      expect(rows).toContain('missing')
      expect(rows).not.toContain('failing')
    })
  })
})
