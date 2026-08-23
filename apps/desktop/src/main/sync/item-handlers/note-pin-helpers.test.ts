import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { createTestIndexDb, sql, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'

import { applyPinnedTags, getPinnedTagsForNote } from '@memry/sync-client/item-handlers/note-pin-helpers'

function insertNote(indexDb: TestDb, id: string): void {
  indexDb.run(sql`
    INSERT INTO note_cache (id, path, title, content_hash, word_count, character_count, created_at, modified_at)
    VALUES (${id}, ${`notes/${id}.md`}, ${id}, ${`hash-${id}`}, 1, 1, '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z')
  `)
}

function insertTag(indexDb: TestDb, noteId: string, tag: string, pinnedAt: string | null): void {
  indexDb.insert(noteTags).values({ noteId, tag, pinnedAt }).run()
}

describe('note pin helpers', () => {
  let indexResult: TestDatabaseResult
  let indexDb: TestDb

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:34:56.000Z'))
    indexResult = createTestIndexDb()
    indexDb = indexResult.db
    insertNote(indexDb, 'note-1')
    insertTag(indexDb, 'note-1', 'work', null)
    insertTag(indexDb, 'note-1', 'pinned', '2026-05-01T00:00:00.000Z')
  })

  afterEach(() => {
    vi.useRealTimers()
    indexResult.close()
  })

  it('reads pinned tags and applies pin/unpin updates only to existing note tags', () => {
    expect(getPinnedTagsForNote(indexDb, 'note-1')).toEqual(['pinned'])

    applyPinnedTags(indexDb, 'note-1', ['work', 'missing'])

    expect(getPinnedTagsForNote(indexDb, 'note-1')).toEqual(['work'])
    const rows = indexDb
      .select()
      .from(noteTags)
      .orderBy(noteTags.tag)
      .all()
      .map((row) => ({ tag: row.tag, pinnedAt: row.pinnedAt }))

    expect(rows).toEqual([
      { tag: 'pinned', pinnedAt: null },
      { tag: 'work', pinnedAt: '2026-05-10T12:34:56.000Z' }
    ])
  })
})
