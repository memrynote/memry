import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { createTestDataDb } from '@tests/utils/test-db'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { makeHomePageHandlers, registerHomePageHandlers } from './home-page-handlers'

// Mock electron ipcMain so registerHomePageHandlers can run in tests
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

// Mock requireDatabase to throw (simulates no vault open at registration time)
vi.mock('../database', () => ({
  requireDatabase: vi.fn(() => {
    throw new Error('No vault is open')
  })
}))

const broadcast = vi.hoisted(() => vi.fn())
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: broadcast }))

const syncEffects = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn()
}))
vi.mock('../home/runtime-effects', () => ({
  enqueueHomePageCreate: syncEffects.create,
  enqueueHomePageUpdate: syncEffects.update,
  enqueueHomePageDelete: syncEffects.delete
}))

describe('registerHomePageHandlers — lazy DB resolution', () => {
  it('does not throw at registration and registers all 6 channels without touching the DB', async () => {
    const { ipcMain } = await import('electron')
    const handleMock = vi.mocked(ipcMain.handle)
    handleMock.mockClear()

    // If the fix regresses, requireDatabase() is called eagerly here → throws
    expect(() => registerHomePageHandlers()).not.toThrow()

    // All 6 channels must be registered
    expect(handleMock.mock.calls.length).toBe(6)
  })
})

describe('home-page handlers', () => {
  let dbResult: TestDatabaseResult
  let h: ReturnType<typeof makeHomePageHandlers>

  beforeEach(() => {
    dbResult = createTestDataDb()
    h = makeHomePageHandlers(dbResult.db as Parameters<typeof makeHomePageHandlers>[0])
    broadcast.mockClear()
    syncEffects.create.mockClear()
    syncEffects.update.mockClear()
    syncEffects.delete.mockClear()
  })

  afterEach(() => {
    dbResult.close()
  })

  it('creates and lists a board with parsed widgets', async () => {
    await h.create({ name: 'Work', position: 0, widgets: [] })
    const boards = await h.list()
    expect(boards).toHaveLength(1)
    expect(Array.isArray(boards[0].widgets)).toBe(true)
  })

  it('updates widgets array', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    await h.update({
      id: board.id,
      widgets: [{ id: 'w1', type: 'bookmarks', x: 0, y: 0, w: 4, h: 4, config: {} }]
    })
    const boards = await h.list()
    expect(boards[0].widgets[0].type).toBe('bookmarks')
  })

  // This file is the only non-test caller of the query layer, so a write path
  // that skips the enqueue syncs nothing, with no error to notice.
  it('enqueues a sync create and broadcasts on create', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })

    expect(syncEffects.create).toHaveBeenCalledWith(board.id)
    expect(broadcast).toHaveBeenCalledWith('home-pages:created', { id: board.id })
  })

  it('enqueues a sync update and broadcasts on update', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    syncEffects.update.mockClear()
    broadcast.mockClear()

    await h.update({ id: board.id, name: 'Focus' })

    expect(syncEffects.update).toHaveBeenCalledWith(board.id)
    expect(broadcast).toHaveBeenCalledWith('home-pages:updated', { id: board.id })
  })

  it('snapshots the row BEFORE deleting so the tombstone carries a payload', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    syncEffects.delete.mockClear()
    broadcast.mockClear()

    await h.delete(board.id)

    // RecordSyncController.enqueueDelete returns early on a null payload — a
    // post-delete snapshot would silently drop the tombstone and the board would
    // resurrect from peers.
    const [id, snapshot] = syncEffects.delete.mock.calls[0]
    expect(id).toBe(board.id)
    expect(snapshot).toMatchObject({ id: board.id, name: 'Work' })
    expect(broadcast).toHaveBeenCalledWith('home-pages:deleted', { id: board.id })
  })

  it('does not enqueue or broadcast a delete for an unknown board', async () => {
    expect(await h.delete('missing')).toEqual({ success: false })
    expect(syncEffects.delete).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('enqueues one update per moved board on reorder, and none for a no-op', async () => {
    const a = await h.create({ name: 'A', position: 0, widgets: [] })
    const b = await h.create({ name: 'B', position: 1, widgets: [] })
    const c = await h.create({ name: 'C', position: 2, widgets: [] })
    syncEffects.update.mockClear()
    broadcast.mockClear()

    await h.reorder({ ids: [b.id, a.id, c.id] })

    expect(syncEffects.update.mock.calls.flat().sort()).toEqual([a.id, b.id].sort())
    expect(broadcast).toHaveBeenCalledTimes(2)

    syncEffects.update.mockClear()
    await h.reorder({ ids: [b.id, a.id, c.id] })
    expect(syncEffects.update).not.toHaveBeenCalled()
  })

  it('renders a board with an unparseable widgets blob as empty instead of throwing', async () => {
    // Throwing out of `list` made the renderer fall back to `[]` with
    // isLoading: false, which tripped the first-run seed and minted a brand-new
    // board on every launch.
    dbResult.db
      .insert(homePages)
      .values({ id: 'broken', name: 'Broken', position: 0, widgets: 'not json' })
      .run()
    dbResult.db
      .insert(homePages)
      .values({ id: 'fine', name: 'Fine', position: 1, widgets: '[]' })
      .run()

    const boards = await h.list()

    expect(boards.map((board) => board.id)).toEqual(['broken', 'fine'])
    expect(boards[0].widgets).toEqual([])
    // The bad row is left on disk untouched — nothing is rewritten behind the user.
    expect(
      dbResult.db.select().from(homePages).where(eq(homePages.id, 'broken')).get()?.widgets
    ).toBe('not json')
  })
})
