/**
 * notes:get-tags feeds the editor's `#` autocomplete and the tag pickers.
 * These tests pin that it shares the hub query's sweep predicate: a tag
 * created from the hub is offered before anything uses it, while a bare
 * auto-minted definition is still collected.
 *
 * @module vault/notes-queries.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

const dbs = vi.hoisted(() => ({
  data: undefined as unknown,
  index: undefined as unknown
}))

vi.mock('../database', () => ({
  getDatabase: () => dbs.data,
  getIndexDatabase: () => dbs.index
}))

import { getOrCreateTag, updateTagColor } from '../database/queries/tag-definitions'
import { getTagsWithCounts } from './notes-queries'

describe('getTagsWithCounts (notes:get-tags)', () => {
  let dataResult: TestDatabaseResult
  let indexResult: TestDatabaseResult

  beforeEach(() => {
    dataResult = createTestDataDb()
    indexResult = createTestIndexDb()
    dbs.data = dataResult.db
    dbs.index = indexResult.db
  })

  afterEach(() => {
    dataResult.close()
    indexResult.close()
  })

  function readDefinitionNames(): string[] {
    return dataResult.db
      .all<{ name: string }>(sql`SELECT name FROM tag_definitions ORDER BY name`)
      .map((row) => row.name)
  }

  it('offers a tag the hub created at count 0 instead of collecting it', () => {
    // #given: the hub's create path — getOrCreateTag then updateTagColor
    getOrCreateTag(asClientDb(dataResult.db), 'Reading')
    updateTagColor(asClientDb(dataResult.db), 'Reading', 'emerald')

    // #when: the `#` autocomplete or a picker loads the list
    const tags = getTagsWithCounts()

    // #then: offered at zero, and the definition survives the read
    const reading = tags.find((tag) => tag.tag === 'Reading')
    expect(reading).toMatchObject({ tag: 'Reading', count: 0, color: 'emerald' })
    expect(readDefinitionNames()).toContain('Reading')
    expect(getTagsWithCounts().find((tag) => tag.tag === 'Reading')).toBeDefined()
  })

  it('still collects a bare auto-minted definition with no usage', () => {
    // #given: a definition nobody shaped and nothing uses
    getOrCreateTag(asClientDb(dataResult.db), 'stale')

    // #when
    const tags = getTagsWithCounts()

    // #then
    expect(tags.find((tag) => tag.tag === 'stale')).toBeUndefined()
    expect(readDefinitionNames()).not.toContain('stale')
  })
})
