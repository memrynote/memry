import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb } from '@tests/utils/test-db'
import {
  getSetting,
  setSetting,
  deleteSetting,
  insertSavedFilter,
  updateSavedFilter,
  getSavedFilterById,
  listSavedFilters,
  reorderSavedFilters
} from './settings'

describe('settings queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('stores and retrieves settings', () => {
    expect(getSetting(db, 'theme')).toBeNull()

    setSetting(db, 'theme', 'light')
    expect(getSetting(db, 'theme')).toBe('light')

    setSetting(db, 'theme', 'dark')
    expect(getSetting(db, 'theme')).toBe('dark')

    deleteSetting(db, 'theme')
    expect(getSetting(db, 'theme')).toBeNull()
  })

  it('manages saved filters', () => {
    const filter = insertSavedFilter(db, {
      id: 'filter-1',
      name: 'Important',
      config: { priority: 'high' },
      position: 0
    })
    expect(filter.name).toBe('Important')

    const updated = updateSavedFilter(db, 'filter-1', { name: 'Updated' })
    expect(updated?.name).toBe('Updated')

    expect(getSavedFilterById(db, 'filter-1')?.name).toBe('Updated')

    insertSavedFilter(db, {
      id: 'filter-2',
      name: 'Recent',
      config: { days: 7 },
      position: 1
    })

    const listed = listSavedFilters(db)
    expect(listed.map((f) => f.id)).toEqual(['filter-1', 'filter-2'])

    reorderSavedFilters(db, ['filter-2', 'filter-1'], [0, 1])
    const reordered = listSavedFilters(db)
    expect(reordered.map((f) => f.id)).toEqual(['filter-2', 'filter-1'])
  })
})
