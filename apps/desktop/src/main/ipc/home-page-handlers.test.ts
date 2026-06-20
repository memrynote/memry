import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb } from '@tests/utils/test-db'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { makeHomePageHandlers } from './home-page-handlers'

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
      widgets: [{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }]
    })
    const boards = await h.list()
    expect(boards[0].widgets[0].type).toBe('bookmarks')
  })
})
