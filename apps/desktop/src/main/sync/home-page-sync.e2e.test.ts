import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'

const broadcast = vi.hoisted(() => vi.fn())
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: broadcast }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { SyncQueueManager } from '@memry/sync-client/queue'
import { initHomePageSyncService, resetHomePageSyncService } from '@memry/sync-client/home-page-sync'
import { getRemoteSyncAdapter } from './item-handlers'
import { makeHomePageHandlers } from '../ipc/home-page-handlers'

/**
 * Home board sync crosses three seams that each no-op silently on their own: the
 * handler registry, the local-mutation registry, and the runtime adapter list.
 * This is the only test that fails if ANY of them is missing — it drives real
 * IPC writes on device A, reads what actually landed in A's queue, and replays
 * it into a second database as device B.
 */
describe('home board sync, device A → device B', () => {
  let deviceA: TestDatabaseResult
  let deviceB: TestDatabaseResult
  let queue: SyncQueueManager
  let handlers: ReturnType<typeof makeHomePageHandlers>

  const emit = vi.fn()
  const rowOnB = (id: string) =>
    deviceB.db.select().from(homePages).where(eq(homePages.id, id)).get()

  beforeEach(() => {
    deviceA = createTestDataDb()
    deviceB = createTestDataDb()
    queue = new SyncQueueManager(asSyncDb(deviceA.db))
    initHomePageSyncService({
      queue,
      db: deviceA.db as never,
      getDeviceId: () => 'device-a'
    })
    handlers = makeHomePageHandlers(
      deviceA.db as unknown as Parameters<typeof makeHomePageHandlers>[0]
    )
    emit.mockClear()
    broadcast.mockClear()
  })

  afterEach(() => {
    resetHomePageSyncService()
    deviceA.close()
    deviceB.close()
  })

  /** Drain A's queue into B, exactly as the pull path would. */
  const replayOnB = (): void => {
    const adapter = getRemoteSyncAdapter('home_page')
    expect(adapter, 'home_page is not registered in item-handlers/index.ts').toBeDefined()

    for (const item of queue.dequeue(50)) {
      expect(item.type).toBe('home_page')
      const payload = JSON.parse(item.payload) as Record<string, unknown>
      const parsed = adapter!.schema.safeParse(payload)
      expect(parsed.success, `payload failed ${item.operation} schema parse`).toBe(true)

      adapter!.applyRemoteMutation({
        db: deviceB.db as never,
        emit,
        itemId: item.itemId,
        operation: item.operation as 'create' | 'update' | 'delete',
        data: parsed.success ? (parsed.data as never) : undefined,
        clock: payload.clock as Record<string, number> | undefined,
        vaultKey: undefined
      })
    }
  }

  it('carries a create, a widget drag, a reorder and a delete across, byte-for-byte', async () => {
    const board = await handlers.create({ name: 'Work', position: 0, widgets: [] })
    replayOnB()
    expect(rowOnB(board.id)).toMatchObject({ name: 'Work', position: 0 })

    // Drag: widgets travel as an opaque JSON string, so B's blob must be
    // byte-identical to A's — this is what a typed payload would have broken.
    await handlers.update({
      id: board.id,
      widgets: [{ id: 'w1', type: 'bookmarks', x: 3, y: 5, w: 2, h: 6, config: { limit: 7 } }]
    })
    replayOnB()
    const widgetsOnA = deviceA.db
      .select()
      .from(homePages)
      .where(eq(homePages.id, board.id))
      .get()?.widgets
    expect(rowOnB(board.id)?.widgets).toBe(widgetsOnA)

    // Reorder: only moved boards push, and the move lands on B.
    const second = await handlers.create({ name: 'Personal', position: 1, widgets: [] })
    replayOnB()
    await handlers.reorder({ ids: [second.id, board.id] })
    replayOnB()
    expect(rowOnB(second.id)?.position).toBe(0)
    expect(rowOnB(board.id)?.position).toBe(1)

    // Delete: without the pre-delete snapshot the tombstone carries no payload
    // and the board resurrects on the next pull.
    await handlers.delete(board.id)
    replayOnB()
    expect(rowOnB(board.id)).toBeUndefined()
    expect(rowOnB(second.id)).toBeDefined()
  })

  it('round-trips a legacy {size} widget blob through the real write path', async () => {
    const board = await handlers.create({ name: 'Legacy', position: 0, widgets: [] })
    // Written the way a pre-grid build left it on disk — the IPC schema would
    // reject it, so it goes straight to the row, as an upgraded install has it.
    const legacy = JSON.stringify([{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }])
    deviceA.db.update(homePages).set({ widgets: legacy }).where(eq(homePages.id, board.id)).run()
    queue.dequeue(50)

    // Any local write re-reads the live row, so the legacy blob rides along.
    await handlers.update({ id: board.id, name: 'Legacy renamed' })
    replayOnB()

    expect(rowOnB(board.id)?.widgets).toBe(legacy)
    expect(rowOnB(board.id)?.name).toBe('Legacy renamed')
  })
})
