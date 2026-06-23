import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb } from '@tests/utils/test-db'
import {
  listHomePages,
  getHomePage,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from './home-pages'

describe('home-pages queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('inserts and lists a board ordered by position', () => {
    insertHomePage(db, { id: 'b1', name: 'Work', position: 0, widgets: '[]' })
    insertHomePage(db, { id: 'b2', name: 'Personal', position: 1, widgets: '[]' })
    const rows = listHomePages(db)
    expect(rows.map((r) => r.id)).toEqual(['b1', 'b2'])
  })

  it('updates name and widgets', () => {
    insertHomePage(db, { id: 'b1', name: 'Work', position: 0, widgets: '[]' })
    updateHomePage(db, 'b1', { name: 'Focus', widgets: '[{"id":"w1"}]' })
    expect(getHomePage(db, 'b1')?.name).toBe('Focus')
  })

  it('reorders boards by id list', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    insertHomePage(db, { id: 'b2', name: 'B', position: 1, widgets: '[]' })
    reorderHomePages(db, ['b2', 'b1'])
    expect(listHomePages(db).map((r) => r.id)).toEqual(['b2', 'b1'])
  })

  it('deletes a board', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    deleteHomePage(db, 'b1')
    expect(listHomePages(db)).toHaveLength(0)
  })
})
