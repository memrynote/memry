import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { canvases, canvasEntityRefs, canvasAssets } from '@memry/db-schema/data-schema'
import type { CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'
import type { SyncQueueManager } from '../queue'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

// M5 asset IO is mocked: these modules transitively import electron (vault /
// ipc / sync runtime), and the unit tests must never touch real network/disk.
// `recordAsset` (asset-store) and `readMemryAssets` (memry-assets) are left REAL
// — they are electron-free plain DB writes / JSON parsing under test.
const { mockBuildAssetServiceContext, mockEnsureAssetsPresent, mockReconcileCanvasAssets } =
  vi.hoisted(() => ({
    mockBuildAssetServiceContext: vi.fn(),
    mockEnsureAssetsPresent: vi.fn(),
    mockReconcileCanvasAssets: vi.fn()
  }))
vi.mock('../../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: mockBuildAssetServiceContext
}))
vi.mock('../../canvas/assets/asset-service', () => ({
  ensureAssetsPresent: mockEnsureAssetsPresent,
  reconcileCanvasAssets: mockReconcileCanvasAssets
}))

// Canvases are files in the vault now; point the handler at a temp folder.
const vaultDir = vi.hoisted(() => ({ current: '' }))
vi.mock('../../canvas/vault-path', () => ({
  getCanvasVaultPath: () => vaultDir.current || null
}))

import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

import { canvasHandler } from './canvas-handler'
import { CANVAS_DIR, resolveCanvasFile, withCanvasMeta } from '../../canvas/scene-file'
import { readCanvasScene } from '../../canvas/store'
import { hashesReferencedByOtherCanvases } from '../../canvas/assets/asset-store'
import { initCanvasSyncService, resetCanvasSyncService } from '../canvas-sync'

const ASSET_CTX = { marker: 'asset-ctx' }

/**
 * The stored document is normalized (stable key order, explicit appState/files),
 * so scenes are compared by content rather than byte-for-byte.
 */
function expectScene(row: { filePath: string | null } | undefined, expected: string): void {
  const actual = readCanvasScene(vaultDir.current, row?.filePath ?? null)
  expect(actual).not.toBeNull()
  expect(JSON.parse(actual!)).toEqual(JSON.parse(expected))
}

function asset(hash: string): MemryAssetDescriptor {
  return {
    fileId: `file-${hash}`,
    attachmentId: `att-${hash}`,
    contentHash: hash,
    chunkHashes: [`chunk-${hash}`],
    mimeType: 'image/png',
    sizeBytes: 1024,
    filename: `${hash}.png`
  }
}

function sceneWithAssets(entityId: string, assets: MemryAssetDescriptor[], extra = ''): string {
  const base = JSON.parse(sceneWith(entityId, extra)) as Record<string, unknown>
  base.memryAssets = assets
  return JSON.stringify(base)
}

const VAULT_ID = 'vault-1'
const LOCAL_DEVICE = 'device-LOCAL'

type MockQueue = Pick<SyncQueueManager, 'enqueue'> & { enqueue: ReturnType<typeof vi.fn> }

function sceneWith(entityId: string, extra = ''): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [
      {
        id: `rect-${entityId}`,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 260,
        height: 168,
        angle: 0,
        customData: { entityType: 'note', entityId }
      }
    ],
    appState: {},
    files: {},
    marker: extra
  })
}

function seedCanvas(
  db: DrizzleDb,
  id: string,
  scene: string,
  clock: VectorClock | null,
  opts: { deletedAt?: number | null; title?: string | null } = {}
): void {
  const now = Date.now()
  const filePath = `${CANVAS_DIR}/${id}.excalidraw`
  fs.mkdirSync(nodePath.join(vaultDir.current, CANVAS_DIR), { recursive: true })
  fs.writeFileSync(
    resolveCanvasFile(vaultDir.current, filePath),
    withCanvasMeta(scene, { id, createdAt: now, updatedAt: now })
  )
  db.insert(canvases)
    .values({
      id,
      vaultId: VAULT_ID,
      title: opts.title ?? 'My Canvas',
      filePath,
      snapshotCiphertext: '',
      vectorClock: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: opts.deletedAt ?? null,
      lastSyncedAt: null,
      clock
    })
    .run()
}

describe('canvasHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext
  let db: DrizzleDb
  let mockQueue: MockQueue

  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    testDb = createTestDataDb()
    db = testDb.db as unknown as DrizzleDb
    mockQueue = { enqueue: vi.fn() }
    initCanvasSyncService({
      queue: mockQueue as unknown as SyncQueueManager,
      db,
      getDeviceId: () => LOCAL_DEVICE
    })
    vaultDir.current = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'memry-canvas-sync-'))
    ctx = { db, emit: vi.fn() }
    mockBuildAssetServiceContext.mockReset().mockReturnValue(ASSET_CTX)
    mockEnsureAssetsPresent.mockReset().mockResolvedValue(undefined)
    mockReconcileCanvasAssets.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    resetCanvasSyncService()
    testDb.close()
    if (vaultDir.current) fs.rmSync(vaultDir.current, { recursive: true, force: true })
  })

  describe('applyUpsert', () => {
    it('#given no existing row #when remote create arrives #then inserts encrypted row + entity refs', () => {
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        title: 'Remote',
        scene: sceneWith('note-1'),
        clock: { B: 1 }
      }

      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row).toBeDefined()
      expect(row!.clock).toEqual({ B: 1 })
      expectScene(row, data.scene)
      const refs = db
        .select()
        .from(canvasEntityRefs)
        .where(eq(canvasEntityRefs.canvasId, 'c1'))
        .all()
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ entityType: 'note', entityId: 'note-1' })
    })

    it('#given a payload without a scene #then skips (D5) and never clobbers local ink', () => {
      seedCanvas(db, 'c1', sceneWith('note-keep'), { A: 1 })
      const data: CanvasSyncPayload = { id: 'c1', vaultId: VAULT_ID, clock: { A: 1, B: 5 } }

      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { A: 1, B: 5 })

      expect(result).toBe('skipped')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expectScene(row, sceneWith('note-keep'))
    })

    it('#given existing row #when remote clock is newer #then overwrites + rebuilds refs', () => {
      seedCanvas(db, 'c1', sceneWith('note-old'), { A: 1 })

      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        scene: sceneWith('note-new'),
        clock: { A: 1, B: 2 }
      }
      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { A: 1, B: 2 })

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.clock).toEqual({ A: 1, B: 2 })
      expectScene(row, data.scene)
      const refs = db
        .select()
        .from(canvasEntityRefs)
        .where(eq(canvasEntityRefs.canvasId, 'c1'))
        .all()
      expect(refs.map((r) => r.entityId)).toEqual(['note-new'])
    })

    it('#given existing row #when local clock is newer #then skips', () => {
      seedCanvas(db, 'c1', sceneWith('note-keep'), { A: 5 })

      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        scene: sceneWith('note-remote'),
        clock: { A: 2 }
      }
      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { A: 2 })

      expect(result).toBe('skipped')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expectScene(row, sceneWith('note-keep'))
    })

    it('#given concurrent clocks #then builds a conflict copy (TWO rows, no ink lost) + enqueues push', () => {
      const localScene = sceneWith('note-local')
      seedCanvas(db, 'c1', localScene, { A: 2 })

      const remoteScene = sceneWith('note-remote')
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        scene: remoteScene,
        clock: { B: 3 }
      }

      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { B: 3 })

      expect(result).toBe('conflict')

      const rows = db.select().from(canvases).all()
      expect(rows).toHaveLength(2)

      // Original row now holds the remote (winning) scene + merged clock.
      const original = rows.find((r) => r.id === 'c1')!
      expect(original.clock).toEqual({ A: 2, B: 3 })
      expectScene(original, remoteScene)

      // The conflict copy preserves the LOSING local scene under a fresh id/clock.
      const copy = rows.find((r) => r.id !== 'c1')!
      expect(copy.title).toContain('(conflict copy)')
      expect(copy.clock).toEqual({ [LOCAL_DEVICE]: 1 })
      expect(copy.deletedAt).toBeNull()
      expectScene(copy, localScene)

      // Copy's advisory refs are duplicated.
      const copyRefs = db
        .select()
        .from(canvasEntityRefs)
        .where(eq(canvasEntityRefs.canvasId, copy.id))
        .all()
      expect(copyRefs.map((r) => r.entityId)).toEqual(['note-local'])

      // The copy is enqueued for push (metadata-only — the plaintext scene must
      // NOT sit in the sync queue at rest; buildPushPayload rebuilds it from the
      // copy row at push time).
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'canvas', itemId: copy.id, operation: 'create' })
      )
      const enqueued = mockQueue.enqueue.mock.calls.find(
        (c) => (c[0] as { itemId: string }).itemId === copy.id
      )![0] as { payload: string }
      expect(JSON.parse(enqueued.payload)).not.toHaveProperty('scene')
    })

    it('#given concurrent clocks but IDENTICAL scenes #then no conflict copy (clock merge only)', () => {
      const scene = sceneWith('note-same')
      seedCanvas(db, 'c1', scene, { A: 2 })

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, scene, clock: { B: 3 } },
        { B: 3 }
      )

      expect(result).toBe('applied')
      expect(db.select().from(canvases).all()).toHaveLength(1)
      expect(mockQueue.enqueue).not.toHaveBeenCalled()
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.clock).toEqual({ A: 2, B: 3 })
    })

    it('#given concurrent clocks + no running sync service #then still preserves the losing scene (unclocked, seeded later)', () => {
      resetCanvasSyncService()
      seedCanvas(db, 'c1', sceneWith('note-local'), { A: 2 })

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, scene: sceneWith('note-remote'), clock: { B: 3 } },
        { B: 3 }
      )

      expect(result).toBe('conflict')
      const rows = db.select().from(canvases).all()
      expect(rows).toHaveLength(2)
      const copy = rows.find((r) => r.id !== 'c1')!
      // No device id → unclocked copy; seedUnclocked pushes it on the next init.
      expect(copy.clock).toBeNull()
      expectScene(copy, sceneWith('note-local'))
    })

    it('#given an update that clears the title (null) #then propagates the clear', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 }, { title: 'Old' })

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          title: null,
          scene: sceneWith('note-2'),
          clock: { A: 1, B: 2 }
        },
        { A: 1, B: 2 }
      )

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.title).toBeNull()
    })
  })

  describe('applyDelete', () => {
    it('#given existing row #when delete arrives #then soft-tombstones + prunes refs (D3)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-1'),
          clock: { A: 1 }
        },
        { A: 1 }
      )

      const result = canvasHandler.applyDelete(ctx, 'c1', { A: 1, B: 2 })

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row).toBeDefined()
      expect(row!.deletedAt).not.toBeNull()
      // The delete clock is persisted on the tombstone (not the stale pre-delete
      // clock) so later concurrent edits resolve consistently across devices.
      expect(row!.clock).toEqual({ A: 1, B: 2 })
      const refs = db
        .select()
        .from(canvasEntityRefs)
        .where(eq(canvasEntityRefs.canvasId, 'c1'))
        .all()
      expect(refs).toHaveLength(0)
    })

    it('#given local edits newer than the delete #then skips (delete loses to concurrent edit, R13)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 5 })

      const result = canvasHandler.applyDelete(ctx, 'c1', { A: 2 })

      expect(result).toBe('skipped')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.deletedAt).toBeNull()
    })

    it('#given no existing row #then skips', () => {
      expect(canvasHandler.applyDelete(ctx, 'missing', { A: 1 })).toBe('skipped')
    })

    it('#given an already-tombstoned row #then skips (idempotent)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 }, { deletedAt: Date.now() })
      expect(canvasHandler.applyDelete(ctx, 'c1', { A: 1, B: 9 })).toBe('skipped')
    })
  })

  describe('buildPushPayload', () => {
    it('#given a row with a document #then returns a scene-bearing payload', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      const payload = canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update')
      expect(payload).not.toBeNull()
      const parsed = JSON.parse(payload!)
      expect(JSON.parse(parsed.scene)).toEqual(JSON.parse(sceneWith('note-1')))
      expect(parsed.vaultId).toBe(VAULT_ID)
      expect(parsed.clock).toEqual({ A: 1 })
    })

    it('#given a row whose document is unreadable #then returns null (never pushes empty ink)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      fs.rmSync(resolveCanvasFile(vaultDir.current, `${CANVAS_DIR}/c1.excalidraw`))

      expect(canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update')).toBeNull()
    })

    it('#given no open vault #then returns null', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      const open = vaultDir.current
      vaultDir.current = ''
      try {
        expect(canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update')).toBeNull()
      } finally {
        vaultDir.current = open
      }
    })

    it('#given no row #then returns null', () => {
      expect(canvasHandler.buildPushPayload!(db, 'missing', 'device-A', 'update')).toBeNull()
    })
  })

  describe('seedUnclocked', () => {
    it('#given an unclocked live canvas #then assigns a clock + enqueues a create (D7)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), null)

      const count = canvasHandler.seedUnclocked(
        db,
        'device-A',
        mockQueue as unknown as SyncQueueManager
      )

      expect(count).toBe(1)
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.clock).toEqual({ 'device-A': 1 })
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'canvas', itemId: 'c1', operation: 'create' })
      )
    })

    it('#given an unclocked TOMBSTONE #then does NOT seed it (D2: no fleet-wide resurrection)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), null, { deletedAt: Date.now() })

      const count = canvasHandler.seedUnclocked(
        db,
        'device-A',
        mockQueue as unknown as SyncQueueManager
      )

      expect(count).toBe(0)
      expect(mockQueue.enqueue).not.toHaveBeenCalled()
      const row = db
        .select()
        .from(canvases)
        .where(and(eq(canvases.id, 'c1'), isNull(canvases.clock)))
        .get()
      expect(row).toBeDefined()
    })
  })

  describe('M5 asset ingestion / restore / GC', () => {
    it('#given a create carrying 2 memryAssets #then records 2 rows + restores after commit', () => {
      const a1 = asset('h1')
      const a2 = asset('h2')
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        title: 'Remote',
        scene: sceneWithAssets('note-1', [a1, a2]),
        clock: { B: 1 }
      }

      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })

      expect(result).toBe('applied')
      const rows = db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, 'c1')).all()
      expect(rows.map((r) => r.contentHash).sort()).toEqual(['h1', 'h2'])
      expect(rows.every((r) => r.vaultId === VAULT_ID)).toBe(true)
      // Restore is fired AFTER the tx commits, once, with the same descriptors.
      expect(mockEnsureAssetsPresent).toHaveBeenCalledTimes(1)
      expect(mockEnsureAssetsPresent).toHaveBeenCalledWith(ASSET_CTX, 'c1', [a1, a2])
    })

    it('#given a concurrent-clock conflict copy #then records shared assets under BOTH ids (GC union protects them)', () => {
      const shared = asset('shared')
      seedCanvas(db, 'c1', sceneWithAssets('note-local', [shared]), { A: 2 })

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWithAssets('note-remote', [shared]),
          clock: { B: 3 }
        },
        { B: 3 }
      )

      expect(result).toBe('conflict')
      const copy = db
        .select()
        .from(canvases)
        .all()
        .find((r) => r.id !== 'c1')!
      expect(copy).toBeDefined()

      const c1Hashes = db
        .select()
        .from(canvasAssets)
        .where(eq(canvasAssets.canvasId, 'c1'))
        .all()
        .map((r) => r.contentHash)
      const copyHashes = db
        .select()
        .from(canvasAssets)
        .where(eq(canvasAssets.canvasId, copy.id))
        .all()
        .map((r) => r.contentHash)
      expect(c1Hashes).toEqual(['shared'])
      expect(copyHashes).toEqual(['shared'])

      // The union protects the shared asset from GC over EITHER canvas: deleting
      // the original must not reap an asset the conflict copy still references.
      expect(hashesReferencedByOtherCanvases(db, VAULT_ID, 'c1').has('shared')).toBe(true)
      expect(hashesReferencedByOtherCanvases(db, VAULT_ID, copy.id).has('shared')).toBe(true)
    })

    it('#given a remote delete #then GCs the canvas assets with an empty scene', () => {
      seedCanvas(db, 'c1', sceneWithAssets('note-1', [asset('h1')]), { A: 1 })

      const result = canvasHandler.applyDelete(ctx, 'c1', { A: 1, B: 2 })

      expect(result).toBe('applied')
      expect(mockReconcileCanvasAssets).toHaveBeenCalledTimes(1)
      expect(mockReconcileCanvasAssets).toHaveBeenCalledWith(ASSET_CTX, 'c1', '')
    })

    it('#given a skipped delete (local newer) #then does NOT GC', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 5 })

      expect(canvasHandler.applyDelete(ctx, 'c1', { A: 2 })).toBe('skipped')
      expect(mockReconcileCanvasAssets).not.toHaveBeenCalled()
    })

    it('#given a pre-M5 base64 scene (no memryAssets) #then records nothing, restores nothing, never throws', () => {
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        scene: sceneWith('note-1'),
        clock: { B: 1 }
      }

      const result = canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })

      expect(result).toBe('applied')
      expect(db.select().from(canvasAssets).all()).toHaveLength(0)
      expect(mockEnsureAssetsPresent).not.toHaveBeenCalled()
    })

    it('#given a payload without a scene (D5) #then still skips and records no assets', () => {
      seedCanvas(db, 'c1', sceneWithAssets('note-keep', [asset('h1')]), { A: 1 })
      // Seeded row itself recorded no asset rows (seedCanvas bypasses the handler).
      const before = db.select().from(canvasAssets).all().length

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, clock: { A: 1, B: 5 } },
        { A: 1, B: 5 }
      )

      expect(result).toBe('skipped')
      expect(db.select().from(canvasAssets).all()).toHaveLength(before)
      expect(mockEnsureAssetsPresent).not.toHaveBeenCalled()
    })
  })
})
