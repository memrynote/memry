import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { ContentType } from '@memry/contracts/search-api'
import { nameKey } from '@memry/shared/note-names'
import { createTestIndexDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { initializeFts, insertFtsNote } from '../fts'
import { initializeFtsTasks } from '../fts-tasks'
import { initializeFtsInbox } from '../fts-inbox'
import { searchAll } from './search'

describe('search by other names', () => {
  let indexDb: TestDatabaseResult
  let dataDb: TestDatabaseResult

  beforeEach(() => {
    indexDb = createTestIndexDb()
    dataDb = createTestDataDb()
    initializeFts(indexDb.db as never)
    initializeFtsTasks(dataDb.db as never)
    initializeFtsInbox(dataDb.db as never)
  })

  afterEach(() => {
    indexDb.close()
    dataDb.close()
  })

  function seed(
    id: string,
    title: string,
    content: string,
    aliases: string[],
    date: string | null = null
  ): void {
    indexDb.db.run(sql`
      INSERT INTO note_cache (id, path, title, date, created_at, modified_at)
      VALUES (${id}, ${`${id}.md`}, ${title}, ${date}, '2026-01-01', '2026-01-01')
    `)
    for (const alias of aliases) {
      indexDb.db.run(sql`
        INSERT INTO note_names (note_id, key, display, kind)
        VALUES (${id}, ${nameKey(alias)}, ${alias}, 'alias')
      `)
    }
    insertFtsNote(indexDb.db as never, id, title, content, [])
  }

  function search(text: string, types: ContentType[] = ['note']) {
    return searchAll(indexDb.db as never, dataDb.db as never, {
      text,
      types,
      tags: [],
      dateRange: null,
      projectId: null,
      folderPath: null,
      limit: 10,
      offset: 0
    }).groups
  }

  it('finds a note by an other name, once, with the name it matched', () => {
    seed('nte_ai', 'Artificial Intelligence', 'Notes on models.', ['AI', 'AI research'])
    seed('nte_read', 'Reading list', 'Books.', [])

    const [notes] = search('ai')

    expect(notes.results[0]).toMatchObject({
      id: 'nte_ai',
      title: 'Artificial Intelligence',
      metadata: { type: 'note', matchedName: 'AI' }
    })
    expect(notes.results.filter((r) => r.id === 'nte_ai')).toHaveLength(1)
  })

  it('names the alias on a body hit but not on a note whose title shows the query', () => {
    seed('nte_ml', 'Machine learning', 'An ML primer.', ['ML'])
    seed('nte_ml_ops', 'ML ops', 'Pipelines.', ['MLOps'])

    const [notes] = search('ml')

    const named = notes.results.map((r) => [
      r.id,
      (r.metadata as { matchedName?: string }).matchedName
    ])
    expect(named).toEqual([
      ['nte_ml', 'ML'],
      ['nte_ml_ops', undefined]
    ])
  })

  it('finds a journal day by its other name', () => {
    seed('nte_day', '2026-03-01', 'Quiet day.', ['Launch day'], '2026-03-01')

    const groups = search('launch', ['note', 'journal'])

    expect(groups.map((g) => [g.type, g.results.map((r) => r.id)])).toEqual([
      ['journal', ['nte_day']]
    ])
    expect(groups[0].results[0].metadata).toMatchObject({ matchedName: 'Launch day' })
  })
})
