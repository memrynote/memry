import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
})
