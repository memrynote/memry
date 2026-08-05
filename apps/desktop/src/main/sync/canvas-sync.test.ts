import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { canvases } from '@memry/db-schema/data-schema'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { CanvasSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

/**
 * Push side of canvas sync. Real `RecordSyncController`, real
 * `SyncQueueManager`, real migrated in-memory data DB.
 *
 * The queued payload is deliberately metadata-only (no `scene`) — the
 * scene-bearing payload is rebuilt with the vault key by
 * `canvas-handler.buildPushPayload` at push time.
 */

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from './queue'
import {
  CanvasSyncService,
  getCanvasSyncService,
  initCanvasSyncService,
  resetCanvasSyncService
} from './canvas-sync'

let db: TestDataDb
let queue: SyncQueueManager

function seedCanvas(overrides: Record<string, unknown> = {}): void {
  db.insert(canvases)
    .values({
      id: 'canvas-1',
      vaultId: 'vault-1',
      title: 'Roadmap Sketch',
      filePath: 'canvases/Roadmap Sketch.excalidraw',
      snapshotCiphertext: '',
      vectorClock: {},
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      clock: {},
      ...overrides
    } as never)
    .run()
}

function queueRows(): Array<typeof syncQueue.$inferSelect> {
  return db.select().from(syncQueue).all()
}

function payloadOf(row: typeof syncQueue.$inferSelect | undefined): Record<string, unknown> {
  return JSON.parse(row!.payload) as Record<string, unknown>
}

function storedClock(id = 'canvas-1'): unknown {
  return db.select().from(canvases).where(eq(canvases.id, id)).get()?.clock
}

function makeService(deviceId: string | null = 'device-a'): CanvasSyncService {
  return new CanvasSyncService({ queue, db, getDeviceId: () => deviceId })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDataDb()
  queue = new SyncQueueManager(db)
  resetCanvasSyncService()
})

describe('CanvasSyncService push', () => {
  it('enqueues exactly one canvas create carrying the title the user gave it', () => {
    seedCanvas()

    makeService().enqueueCreate('canvas-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('canvas')
    expect(rows[0].itemId).toBe('canvas-1')
    expect(rows[0].operation).toBe('create')

    const payload = payloadOf(rows[0])
    expect(payload).toEqual({
      id: 'canvas-1',
      vaultId: 'vault-1',
      title: 'Roadmap Sketch',
      clock: { 'device-a': 1 },
      deletedAt: null
    })
    expect(CanvasSyncPayloadSchema.safeParse(payload).success).toBe(true)
    // Metadata only by design: the receiver skips a scene-less payload rather
    // than clobbering good ink.
    expect(payload).not.toHaveProperty('scene')
  })

  it('persists the bumped clock on the canvas row', () => {
    seedCanvas({ clock: { 'device-b': 3 } })

    makeService().enqueueUpdate('canvas-1')

    expect(storedClock()).toEqual({ 'device-b': 3, 'device-a': 1 })
    expect(payloadOf(queueRows()[0]).clock).toEqual({ 'device-b': 3, 'device-a': 1 })
  })

  it('seeds a clock for a legacy row that never had one', () => {
    seedCanvas({ clock: null })

    makeService().enqueueCreate('canvas-1')

    expect(storedClock()).toEqual({ 'device-a': 1 })
    expect(payloadOf(queueRows()[0]).clock).toEqual({ 'device-a': 1 })
  })

  it('coalesces a rename into the pending push and keeps the newest title', () => {
    seedCanvas()
    const service = makeService()

    service.enqueueCreate('canvas-1')
    db.update(canvases).set({ title: 'Q3 Roadmap' }).where(eq(canvases.id, 'canvas-1')).run()
    service.enqueueUpdate('canvas-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('create')
    expect(payloadOf(rows[0]).title).toBe('Q3 Roadmap')
  })

  it('skips a canvas that has no row', () => {
    makeService().enqueueUpdate('ghost-canvas')

    expect(queueRows()).toEqual([])
  })

  it('skips every mutation while there is no device id', () => {
    seedCanvas()
    const service = makeService(null)

    service.enqueueCreate('canvas-1')
    service.enqueueUpdate('canvas-1')
    service.enqueueDelete('canvas-1')

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
  })

  it('exposes the device id it was constructed with', () => {
    expect(makeService('device-z').getDeviceId()).toBe('device-z')
    expect(makeService(null).getDeviceId()).toBeNull()
  })
})

describe('CanvasSyncService deletes', () => {
  it('propagates a delete and persists the bumped clock on the tombstone row', () => {
    seedCanvas({ clock: { 'device-a': 2 }, deletedAt: 1_700_000_009_000 })

    makeService().enqueueDelete('canvas-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('canvas')
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toEqual({
      id: 'canvas-1',
      vaultId: 'vault-1',
      clock: { 'device-a': 3 },
      deletedAt: 1_700_000_009_000
    })
    // The bumped clock has to survive on the row so a later concurrent edit
    // resolves against the delete rather than silently winning.
    expect(storedClock()).toEqual({ 'device-a': 3 })
  })

  it('lets a delete win over a still-pending create instead of being dropped', () => {
    seedCanvas()
    const service = makeService()

    service.enqueueCreate('canvas-1')
    service.enqueueDelete('canvas-1')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
  })

  it('drops a delete for a canvas row that no longer exists', () => {
    // Canvas deletes are soft, so the tombstone row is always still present in
    // the real flow; a hard-missing row has no clock to advance.
    makeService().enqueueDelete('never-existed')

    expect(queueRows()).toEqual([])
  })
})

describe('CanvasSyncService local-only clock bumps', () => {
  it('advances the clock without enqueueing any push', () => {
    seedCanvas({ clock: { 'device-a': 1 } })

    makeService().bumpClockLocalOnly('canvas-1')

    // A save that is kept locally but is too large to sync must still move the
    // clock, or a later remote edit dominates it and overwrites the local ink.
    expect(storedClock()).toEqual({ 'device-a': 2 })
    expect(queueRows()).toEqual([])
  })

  it('no-ops without a device id or without a row', () => {
    seedCanvas()

    makeService(null).bumpClockLocalOnly('canvas-1')
    expect(storedClock()).toEqual({})

    makeService().bumpClockLocalOnly('ghost-canvas')
    expect(queueRows()).toEqual([])
  })
})

describe('CanvasSyncService conflict-copy pushes', () => {
  it('enqueues the handler-built payload verbatim, bypassing serialize', () => {
    const payload = JSON.stringify({
      id: 'canvas-copy',
      vaultId: 'vault-1',
      title: 'Roadmap Sketch (conflict copy)',
      scene: 'encrypted-scene',
      clock: { 'device-a': 1 }
    })

    makeService().enqueueConflictCopyPush('canvas-copy', payload)

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('canvas')
    expect(rows[0].itemId).toBe('canvas-copy')
    expect(rows[0].operation).toBe('create')
    expect(rows[0].payload).toBe(payload)
    // This is the one push the apply path is allowed to raise: the conflict
    // copy is new local content, not an echo of what was just pulled.
    expect(payloadOf(rows[0]).scene).toBe('encrypted-scene')
  })
})

describe('canvas sync service lifecycle', () => {
  it('tracks the module-level singleton', () => {
    expect(getCanvasSyncService()).toBeNull()

    const service = initCanvasSyncService({ queue, db, getDeviceId: () => 'device-a' })
    expect(getCanvasSyncService()).toBe(service)

    resetCanvasSyncService()
    expect(getCanvasSyncService()).toBeNull()
  })
})
