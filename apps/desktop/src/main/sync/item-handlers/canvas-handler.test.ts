import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { canvases, canvasEntityRefs } from '@memry/db-schema/data-schema'
import type { CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { canvasHandler } from './canvas-handler'
import { encryptCanvasSceneForVault, decryptCanvasSceneForVault } from '../../canvas/encryption'
import { initCanvasSyncService, resetCanvasSyncService } from '../canvas-sync'

const VAULT_KEY = new Uint8Array(32).fill(7)
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
  db.insert(canvases)
    .values({
      id,
      vaultId: VAULT_ID,
      title: opts.title ?? 'My Canvas',
      snapshotCiphertext: encryptCanvasSceneForVault(scene, VAULT_KEY),
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
    ctx = { db, emit: vi.fn(), vaultKey: VAULT_KEY }
  })

  afterEach(() => {
    resetCanvasSyncService()
    testDb.close()
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
      expect(decryptCanvasSceneForVault(row!.snapshotCiphertext, VAULT_KEY)).toBe(data.scene)
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
      expect(decryptCanvasSceneForVault(row!.snapshotCiphertext, VAULT_KEY)).toBe(
        sceneWith('note-keep')
      )
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
      expect(decryptCanvasSceneForVault(row!.snapshotCiphertext, VAULT_KEY)).toBe(data.scene)
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
      expect(decryptCanvasSceneForVault(row!.snapshotCiphertext, VAULT_KEY)).toBe(
        sceneWith('note-keep')
      )
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
      expect(decryptCanvasSceneForVault(original.snapshotCiphertext, VAULT_KEY)).toBe(remoteScene)

      // The conflict copy preserves the LOSING local scene under a fresh id/clock.
      const copy = rows.find((r) => r.id !== 'c1')!
      expect(copy.title).toContain('(conflict copy)')
      expect(copy.clock).toEqual({ [LOCAL_DEVICE]: 1 })
      expect(copy.deletedAt).toBeNull()
      expect(decryptCanvasSceneForVault(copy.snapshotCiphertext, VAULT_KEY)).toBe(localScene)

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
      expect(decryptCanvasSceneForVault(copy.snapshotCiphertext, VAULT_KEY)).toBe(
        sceneWith('note-local')
      )
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
    it('#given a row + vault key #then returns a scene-bearing payload', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      const payload = canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update', VAULT_KEY)
      expect(payload).not.toBeNull()
      const parsed = JSON.parse(payload!)
      expect(parsed.scene).toBe(sceneWith('note-1'))
      expect(parsed.vaultId).toBe(VAULT_ID)
      expect(parsed.clock).toEqual({ A: 1 })
    })

    it('#given no vault key #then returns null (never re-serializes without the key)', () => {
      seedCanvas(db, 'c1', sceneWith('note-1'), { A: 1 })
      expect(canvasHandler.buildPushPayload!(db, 'c1', 'device-A', 'update')).toBeNull()
    })

    it('#given no row #then returns null', () => {
      expect(
        canvasHandler.buildPushPayload!(db, 'missing', 'device-A', 'update', VAULT_KEY)
      ).toBeNull()
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
})
