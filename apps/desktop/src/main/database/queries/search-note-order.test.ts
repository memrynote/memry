import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestIndexDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { initializeFts, insertFtsNote } from '../fts'
import { initializeFtsTasks } from '../fts-tasks'
import { initializeFtsInbox } from '../fts-inbox'
import { searchAll } from './search'

describe('note search order', () => {
  let indexDb: TestDatabaseResult
  let dataDb: TestDatabaseResult

  beforeEach(() => {
    indexDb = createTestIndexDb()
    dataDb = createTestDataDb()
    initializeFts(indexDb.db)
    initializeFtsTasks(dataDb.db as never)
    initializeFtsInbox(dataDb.db as never)
  })

  afterEach(() => {
    indexDb.close()
    dataDb.close()
  })

  function seed(id: string, fileType: string, title: string, content: string): void {
    indexDb.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${id}, ${`vault/${id}`}, ${title}, ${fileType}, '2026-01-01', '2026-01-01')
    `)
    insertFtsNote(indexDb.db, id, title, content, [])
  }

  it('lists a long markdown note before short OCR-read images that out-rank it', () => {
    const lecture = Array.from({ length: 400 }, (_, i) => `slide ${i} block cipher notes`)
    lecture.splice(200, 0, '## AES')
    seed('lecture', 'markdown', 'Aula CASR 2026-10-12', lecture.join('\n'))
    for (let i = 0; i < 12; i++) {
      seed(`image-${i}`, 'image', `Pasted image ${i}`, 'AES caso de estudo')
    }

    const notes = searchAll(indexDb.db, dataDb.db as never, {
      text: 'aes',
      types: ['note'],
      tags: [],
      dateRange: null,
      projectId: null,
      folderPath: null,
      limit: 10,
      offset: 0
    }).groups[0].results

    expect(notes).toHaveLength(10)
    expect(notes[0].id).toBe('lecture')
    expect(notes.slice(1).every((note) => note.id.startsWith('image-'))).toBe(true)
  })

  describe('exact phrase', () => {
    const search = (text: string, types: Array<'note' | 'journal'>) =>
      searchAll(indexDb.db as never, dataDb.db as never, {
        text,
        types,
        tags: [],
        dateRange: null,
        projectId: null,
        folderPath: null,
        limit: 10,
        offset: 0
      }).groups[0].results.map((r) => r.id)

    const scattered = 'the image is searchable. roughly chopped. this is a recipe'
    const phrase = `${'filler words about structure '.repeat(40)}This is roughly what the top of a note looks like`

    it('lists a note holding the typed words side by side before shorter notes that scatter them', () => {
      seed('scattered', 'markdown', 'Weekday granola', scattered)
      seed('phrase', 'markdown', 'What a note is', phrase)

      expect(search('this is roughly', ['note'])).toEqual(['phrase', 'scattered'])
    })

    it('matches the phrase while the last word is still a prefix', () => {
      seed('scattered', 'markdown', 'Weekday granola', scattered)
      seed('phrase', 'markdown', 'What a note is', phrase)

      expect(search('this is rough', ['note'])[0]).toBe('phrase')
    })

    it('applies to journals', () => {
      for (const [id, content] of [
        ['j-scattered', scattered],
        ['j-phrase', phrase]
      ]) {
        indexDb.db.run(sql`
          INSERT INTO note_cache (id, path, title, date, created_at, modified_at)
          VALUES (${id}, ${`journal/${id}`}, ${id}, '2026-01-01', '2026-01-01', '2026-01-01')
        `)
        insertFtsNote(indexDb.db, id, id, content, [])
      }

      expect(search('this is roughly', ['journal'])).toEqual(['j-phrase', 'j-scattered'])
    })

    it('keeps bm25 order when no note holds the phrase', () => {
      seed('long', 'markdown', 'Long', `${'filler '.repeat(200)} roughly this and is`)
      seed('short', 'markdown', 'Short', 'roughly this and is')

      expect(search('this is roughly', ['note'])).toEqual(['short', 'long'])
    })
  })
})
