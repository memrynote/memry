import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { initializeFts, insertFtsNote } from '../fts'
import { initializeFtsTasks } from '../fts-tasks'
import { initializeFtsInbox } from '../fts-inbox'
import { searchAll, type SemanticHit } from './search'

describe('hybrid search', () => {
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

  function seed(id: string, title: string, content: string, date: string | null = null): void {
    indexDb.db.run(sql`
      INSERT INTO note_cache (id, path, title, date, created_at, modified_at)
      VALUES (${id}, ${`vault/${id}.md`}, ${title}, ${date}, '2026-01-01', '2026-01-01')
    `)
    insertFtsNote(indexDb.db as never, id, title, content, [])
  }

  function search(text: string, hits: SemanticHit[], extra: object = {}) {
    return searchAll(
      indexDb.db as never,
      dataDb.db as never,
      {
        text,
        types: [],
        tags: [],
        dateRange: null,
        projectId: null,
        folderPath: null,
        limit: 10,
        offset: 0,
        ...extra
      },
      hits
    )
  }

  const ids = (response: ReturnType<typeof search>, type: string): string[] =>
    response.groups.find((group) => group.type === type)?.results.map((r) => r.id) ?? []

  it('finds a note that shares no keyword with the query', () => {
    seed('felines', 'Pet care', 'My kitten sleeps on the sofa and purrs')
    expect(ids(search('cat', []), 'note')).toEqual([])

    const response = search('cat', [{ id: 'felines', cosine: 0.76 }])
    expect(ids(response, 'note')).toEqual(['felines'])
    expect(response.totalCount).toBe(1)
  })

  it('lifts a note both legs found above one only FTS found', () => {
    seed('a', 'cat tax', 'cat cat cat')
    seed('b', 'cat habits', 'the cat sleeps')
    const fts = ids(search('cat', []), 'note')
    expect(fts).toHaveLength(2)
    const last = fts[1]

    const fused = search('cat', [{ id: last, cosine: 0.8 }])
    expect(ids(fused, 'note')[0]).toBe(last)
    expect(fused.groups[0].results[0].snippet).toContain('<mark>')
  })

  it('keeps keyword matches ahead of semantic-only ones in cross-group scores', () => {
    seed('kw', 'cat story', 'a cat')
    seed('sem', 'Pet care', 'kitten')
    const results = search('cat', [{ id: 'sem', cosine: 0.9 }]).groups[0].results
    const sem = results.find((r) => r.id === 'sem')!
    const kw = results.find((r) => r.id === 'kw')!
    expect(sem.normalizedScore).toBeLessThanOrEqual(0.5)
    expect(kw.normalizedScore).toBeGreaterThan(sem.normalizedScore)
  })

  it('files journal hits under the journal group and honours the type filter', () => {
    seed('day', '2026-02-01', 'kitten day', '2026-02-01')
    const hits = [{ id: 'day', cosine: 0.7 }]
    expect(ids(search('cat', hits), 'journal')).toEqual(['day'])
    expect(search('cat', hits, { types: ['note'] }).groups).toEqual([])
  })

  it('applies the folder filter to semantic-only hits', () => {
    seed('in', 'Pet care', 'kitten')
    seed('out', 'Pet shop', 'kitten food')
    const response = search(
      'cat',
      [
        { id: 'in', cosine: 0.8 },
        { id: 'out', cosine: 0.7 }
      ],
      { folderPath: 'vault/in' }
    )
    expect(ids(response, 'note')).toEqual(['in'])
  })

  describe('voice memos', () => {
    function seedMemo(id: string, title: string, transcription: string | null): void {
      dataDb.db.run(sql`
        INSERT INTO inbox_items (id, type, title, transcription, created_at, modified_at)
        VALUES (${id}, 'voice', ${title}, ${transcription}, '2026-01-01', '2026-01-01')
      `)
    }

    it('finds a memo that has no transcript and shares no keyword with the query', () => {
      seedMemo('applause', 'Voice memo', null)
      expect(ids(search('crowd cheering', []), 'inbox')).toEqual([])

      const response = search('crowd cheering', [{ id: 'applause', cosine: 0.74 }])
      expect(ids(response, 'inbox')).toEqual(['applause'])
      expect(response.groups.find((g) => g.type === 'inbox')?.results[0]).toMatchObject({
        title: 'Voice memo',
        metadata: { type: 'inbox', itemType: 'voice' }
      })
      expect(
        search('crowd cheering', [{ id: 'applause', cosine: 0.74 }], { types: ['note'] }).groups
      ).toEqual([])
    })

    it('lifts a memo both legs found above one only FTS found', () => {
      seedMemo('a', 'cat tax', 'cat cat cat')
      seedMemo('b', 'cat habits', 'the cat sleeps')
      const fts = ids(search('cat', []), 'inbox')
      expect(fts).toHaveLength(2)
      const last = fts[1]
      expect(ids(search('cat', [{ id: last, cosine: 0.8 }]), 'inbox')[0]).toBe(last)
    })
  })
})
