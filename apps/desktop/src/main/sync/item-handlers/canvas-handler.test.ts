import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { canvases, canvasEntityRefs, canvasAssets } from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import type { CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

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

// The local folder mutations below (rename/delete) and reconcile all enqueue
// through the sync runtime, which drags electron in. Stubbed the same way the
// canvas store suites stub it — nothing here asserts on the queue.
vi.mock('../local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'

import { canvasHandler } from './canvas-handler'
import { canvasFolderHandler } from './canvas-folder-handler'
import { CANVAS_DIR, resolveCanvasFile, withCanvasMeta } from '../../canvas/scene-file'
import { getCanvas, readCanvasScene } from '../../canvas/store'
import {
  deleteCanvasFolder,
  listCanvasFolders,
  renameCanvasFolder
} from '../../canvas/folder-store'
import { reconcileCanvasFiles } from '../../canvas/reconcile'
import { hashesReferencedByOtherCanvases } from '../../canvas/assets/asset-store'
import { initCanvasSyncService, resetCanvasSyncService } from '@memry/sync-client/canvas-sync'

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

  describe('folder placement', () => {
    it('#given a payload with a folder #when a remote create arrives #then files it in that folder', () => {
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        title: 'Remote',
        scene: sceneWith('note-1'),
        folder: 'Work/Q3',
        icon: '🎨',
        clock: { B: 1 }
      }

      expect(canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })).toBe('applied')

      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.folder).toBe('Work/Q3')
      expect(row!.icon).toBe('🎨')
      expect(row!.filePath).toBe(`${CANVAS_DIR}/Work/Q3/Remote.excalidraw`)
      // The directory has to exist before the scene is written, or the write
      // throws and the whole apply rolls back.
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, row!.filePath!))).toBe(true)
      expectScene(row, data.scene)
    })

    it('#given an unsafe folder name #then stores the on-disk-canonical form', () => {
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        title: 'Remote',
        scene: sceneWith('note-1'),
        folder: 'CON',
        clock: { B: 1 }
      }

      expect(canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })).toBe('applied')

      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.folder).toBe('CON canvas')
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, row!.filePath!))).toBe(true)
    })

    it('#given a remote update #then carries the new folder and icon onto the existing row AND moves the document', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-2'),
          folder: 'Work',
          icon: '📐',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.folder).toBe('Work')
      expect(row!.icon).toBe('📐')
      // The row is only half of a move. A `folder` written without moving the
      // FILE puts the canvas in Work in the sidebar and at the root in Finder,
      // and every later placement operation (folder rename, folder delete,
      // reveal, reconcile) then works off a path the document does not occupy.
      // The filename is the canvas's own and never re-derived from the title.
      expect(row!.filePath).toBe(`${CANVAS_DIR}/Work/c1.excalidraw`)
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, row!.filePath!))).toBe(true)
      expect(
        fs.existsSync(resolveCanvasFile(vaultDir.current, `${CANVAS_DIR}/c1.excalidraw`))
      ).toBe(false)
      expectScene(row, sceneWith('note-2'))
    })

    it('#given a remote move back to the root #then the document returns to the canvases root', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-1'),
          folder: 'Work',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, scene: sceneWith('note-2'), folder: null, clock: { A: 3 } },
        { A: 3 }
      )

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.folder).toBeNull()
      expect(row!.filePath).toBe(`${CANVAS_DIR}/c1.excalidraw`)
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, row!.filePath!))).toBe(true)
      expect(
        fs.existsSync(resolveCanvasFile(vaultDir.current, `${CANVAS_DIR}/Work/c1.excalidraw`))
      ).toBe(false)
      expectScene(row, sceneWith('note-2'))
    })

    it('#given the destination folder already holds that filename #then uniquifies instead of overwriting the other canvas', () => {
      seedCanvas(db, 'c1', sceneWith('note-mine'), { A: 1 })
      // Another canvas already owns `Work/c1.excalidraw`. A raw rename replaces
      // the target on every platform — that would be someone else's ink gone.
      fs.mkdirSync(nodePath.join(vaultDir.current, CANVAS_DIR, 'Work'), { recursive: true })
      fs.writeFileSync(
        resolveCanvasFile(vaultDir.current, `${CANVAS_DIR}/Work/c1.excalidraw`),
        withCanvasMeta(sceneWith('note-theirs'), { id: 'other', createdAt: 1, updatedAt: 1 })
      )

      canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-mine'),
          folder: 'Work',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.filePath).toBe(`${CANVAS_DIR}/Work/c1 2.excalidraw`)
      expect(row!.folder).toBe('Work')
      expectScene(row, sceneWith('note-mine'))
      // The squatter is untouched.
      expect(readCanvasScene(vaultDir.current, `${CANVAS_DIR}/Work/c1.excalidraw`)).not.toBeNull()
      expect(
        JSON.parse(readCanvasScene(vaultDir.current, `${CANVAS_DIR}/Work/c1.excalidraw`)!)
      ).toEqual(JSON.parse(sceneWith('note-theirs')))
    })

    it('#given the move cannot be made on disk #then the row describes where the file actually IS', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      // A FILE named `Work` where the directory would go: the rename's mkdir
      // fails, so the document cannot travel. (A locked file or a refused
      // permission reaches the same place.)
      fs.writeFileSync(nodePath.join(vaultDir.current, CANVAS_DIR, 'Work'), 'not a directory')

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-2'),
          folder: 'Work',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      // Never lose the ink: the old path is kept, and the stored folder matches
      // it — a row claiming `Work` would make the canvas unopenable and, worse,
      // unpushable (buildPushPayload reads the file off `filePath`).
      expect(row!.filePath).toBe(`${CANVAS_DIR}/c1.excalidraw`)
      expect(row!.folder).toBeNull()
      expectScene(row, sceneWith('note-2'))
      expect(canvasHandler.buildPushPayload!(db, 'c1', 'device-B', 'update')).not.toBeNull()
    })

    it('#given a pre-folders payload (no folder) #then leaves the document exactly where it is', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-1'),
          folder: 'Work',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      // An absent `folder` is an older build talking, not a move to the root.
      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, scene: sceneWith('note-3'), clock: { A: 3 } },
        { A: 3 }
      )

      expect(result).toBe('applied')
      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.filePath).toBe(`${CANVAS_DIR}/Work/c1.excalidraw`)
      expect(row!.folder).toBe('Work')
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, row!.filePath!))).toBe(true)
    })

    it('#given a legacy payload with no folder #then lands at the canvases root', () => {
      const data: CanvasSyncPayload = {
        id: 'c1',
        vaultId: VAULT_ID,
        title: 'Remote',
        scene: sceneWith('note-1'),
        clock: { B: 1 }
      }

      expect(canvasHandler.applyUpsert(ctx, 'c1', data, { B: 1 })).toBe('applied')

      const row = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(row!.folder).toBeNull()
      expect(row!.filePath).toBe(`${CANVAS_DIR}/Remote.excalidraw`)
    })

    it('#given a conflict on a canvas inside a folder #then the copy lands beside the winner, not at the root', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      canvasHandler.applyUpsert(
        ctx,
        'c1',
        {
          id: 'c1',
          vaultId: VAULT_ID,
          scene: sceneWith('note-local'),
          folder: 'Work',
          clock: { A: 2 }
        },
        { A: 2 }
      )

      const result = canvasHandler.applyUpsert(
        ctx,
        'c1',
        { id: 'c1', vaultId: VAULT_ID, scene: sceneWith('note-remote'), clock: { B: 3 } },
        { B: 3 }
      )

      expect(result).toBe('conflict')
      const copy = db
        .select()
        .from(canvases)
        .all()
        .find((row) => row.id !== 'c1')!
      // The losing ink is only findable if it is where the user is looking. A
      // copy dumped at the root also pushes `folder: null`, so every other
      // device files it at ITS root too.
      expect(copy.folder).toBe('Work')
      expect(copy.filePath!.startsWith(`${CANVAS_DIR}/Work/`)).toBe(true)
      expect(fs.existsSync(resolveCanvasFile(vaultDir.current, copy.filePath!))).toBe(true)
      expectScene(copy, sceneWith('note-local'))
      expect(
        JSON.parse(canvasHandler.buildPushPayload!(db, copy.id, 'device-B', 'create')!).folder
      ).toBe('Work')
    })
  })

  describe('two-device placement lifecycle', () => {
    /**
     * Device B, four steps, in order: a remote MOVE arrives, then the user
     * renames that folder, deletes it, and restarts.
     *
     * Every step after the first works off `canvases.file_path`. If the move
     * only rewrote the row, the damage compounds: the rename re-points the path
     * at a file that was never there (canvas unopenable AND silently unpushable
     * — `buildPushPayload` returns null), and the delete cannot take a directory
     * the document never left, so the next reconcile finds it occupied and
     * revives a folder the user deleted.
     */
    it('#given a remote move, a folder rename, a folder delete and a restart #then the canvas stays openable and pushable and the deleted folder stays deleted', async () => {
      const clientDb = asClientDb(testDb.db)
      const vault = vaultDir.current

      // --- 1. device A drags 'Plan' from the root into 'Work' ---------------
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 }, { title: 'Plan' })
      canvasFolderHandler.applyUpsert(
        ctx,
        canvasFolderSyncId('Work'),
        { id: canvasFolderSyncId('Work'), vaultId: VAULT_ID, path: 'Work', clock: { A: 2 } },
        { A: 2 }
      )
      expect(
        canvasHandler.applyUpsert(
          ctx,
          'c1',
          {
            id: 'c1',
            vaultId: VAULT_ID,
            title: 'Plan',
            scene: sceneWith('note-1'),
            folder: 'Work',
            clock: { A: 2 }
          },
          { A: 2 }
        )
      ).toBe('applied')

      const moved = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(moved!.folder).toBe('Work')
      expect(moved!.filePath).toBe(`${CANVAS_DIR}/Work/c1.excalidraw`)
      expect(fs.existsSync(nodePath.join(vault, CANVAS_DIR, 'Work'))).toBe(true)
      expect(fs.existsSync(resolveCanvasFile(vault, moved!.filePath!))).toBe(true)

      // --- 2. the user renames the folder on B ------------------------------
      renameCanvasFolder(clientDb, vault, VAULT_ID, 'Work', 'Projects')

      const renamed = db.select().from(canvases).where(eq(canvases.id, 'c1')).get()
      expect(renamed!.filePath).toBe(`${CANVAS_DIR}/Projects/c1.excalidraw`)
      expect(fs.existsSync(resolveCanvasFile(vault, renamed!.filePath!))).toBe(true)
      // Still openable...
      expect(getCanvas(clientDb, vault, 'c1')!.unreadable).toBeUndefined()
      // ...and still on the wire. A row pointing at a file that is not there
      // drops the canvas off sync in silence.
      expect(canvasHandler.buildPushPayload!(db, 'c1', 'device-B', 'update')).not.toBeNull()

      // --- 3. the user deletes the folder on B ------------------------------
      const swept = await deleteCanvasFolder(clientDb, vault, VAULT_ID, 'Projects', async (abs) => {
        fs.rmSync(abs, { recursive: true, force: true })
      })
      expect(swept).toEqual(['c1'])
      expect(listCanvasFolders(clientDb, VAULT_ID)).toEqual([])

      // --- 4. restart: reconcile runs at vault open -------------------------
      const result = await reconcileCanvasFiles(clientDb, vault, VAULT_ID)

      // The folder the user deleted does NOT come back — on this device or, via
      // the revival push, on any of the others.
      expect(result.foldersAdopted).toBe(0)
      expect(result.adopted).toBe(0)
      expect(listCanvasFolders(clientDb, VAULT_ID)).toEqual([])
      expect(fs.existsSync(nodePath.join(vault, CANVAS_DIR, 'Work'))).toBe(false)
      expect(fs.existsSync(nodePath.join(vault, CANVAS_DIR, 'Projects'))).toBe(false)
    })
  })

  describe('buildPushPayload', () => {
    it('#given a row in a folder #then the push payload carries folder and icon', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      db.update(canvases).set({ folder: 'Work', icon: '🎨' }).where(eq(canvases.id, 'c1')).run()

      const parsed = JSON.parse(canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update')!)

      expect(parsed.folder).toBe('Work')
      expect(parsed.icon).toBe('🎨')
    })

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
