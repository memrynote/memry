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

  it('returns only the ids whose position changed, and bumps updatedAt on those alone', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    insertHomePage(db, { id: 'b2', name: 'B', position: 1, widgets: '[]' })
    insertHomePage(db, { id: 'b3', name: 'C', position: 2, widgets: '[]' })
    const before = new Map(listHomePages(db).map((r) => [r.id, r.updatedAt]))

    // b3 stays put — a one-slot move must not push every board on the account.
    const changed = reorderHomePages(db, ['b2', 'b1', 'b3'])

    expect(changed.sort()).toEqual(['b1', 'b2'])
    const after = new Map(listHomePages(db).map((r) => [r.id, r.updatedAt]))
    expect(after.get('b3')).toBe(before.get('b3'))
    expect(reorderHomePages(db, ['b2', 'b1', 'b3'])).toEqual([])
  })

  it('tiebreaks equal positions on createdAt then id so every device lists the same order', () => {
    // Concurrent creates on two devices both take `position: boards.length`.
    insertHomePage(db, {
      id: 'zzz',
      name: 'Older',
      position: 0,
      widgets: '[]',
      createdAt: '2026-08-01T00:00:00.000Z'
    })
    insertHomePage(db, {
      id: 'aaa',
      name: 'Newer',
      position: 0,
      widgets: '[]',
      createdAt: '2026-08-02T00:00:00.000Z'
    })
    insertHomePage(db, {
      id: 'bbb',
      name: 'Same instant',
      position: 0,
      widgets: '[]',
      createdAt: '2026-08-02T00:00:00.000Z'
    })

    expect(listHomePages(db).map((r) => r.id)).toEqual(['zzz', 'aaa', 'bbb'])
  })

  it('deletes a board', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    deleteHomePage(db, 'b1')
    expect(listHomePages(db)).toHaveLength(0)
  })
})
