import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  seedInboxItem,
  seedInboxItemTags,
  sql,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { listTagItems } from './tag-items'

// ============================================================================
// Helpers
// (No seedNote/seedTask generic helpers exist in the codebase — notes live in
// index.db, tasks/inbox live in data.db, so seeding follows the raw-SQL
// per-source helper pattern already used in tags.test.ts / graph.test.ts.)
// ============================================================================

function insertNote(indexDb: TestDb, id: string, title: string): void {
  indexDb.run(sql`
    INSERT INTO note_cache (id, path, title, content_hash, word_count, character_count, created_at, modified_at)
    VALUES (${id}, ${`notes/${id}.md`}, ${title}, ${'hash-' + id}, 10, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
}

function insertNoteTag(indexDb: TestDb, noteId: string, tag: string): void {
  indexDb.run(sql`INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (${noteId}, ${tag})`)
}

function insertTask(dataDb: TestDb, id: string, title: string): void {
  dataDb.run(sql`
    INSERT INTO projects (id, name, is_inbox, position)
    VALUES ('inbox', 'Inbox', 1, 0)
    ON CONFLICT DO NOTHING
  `)
  dataDb.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES ('status-default', 'inbox', 'To Do', '#6b7280', 0, 1, 0)
    ON CONFLICT DO NOTHING
  `)
  dataDb.run(sql`
    INSERT INTO tasks (id, project_id, status_id, title, position)
    VALUES (${id}, 'inbox', 'status-default', ${title}, 0)
  `)
}

function insertTaskTag(dataDb: TestDb, taskId: string, tag: string): void {
  dataDb.run(sql`INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (${taskId}, ${tag})`)
}

describe('listTagItems', () => {
  let indexResult: TestDatabaseResult
  let dataResult: TestDatabaseResult
  let indexDb: TestDb
  let dataDb: TestDb

  beforeEach(() => {
    indexResult = createTestIndexDb()
    dataResult = createTestDataDb()
    indexDb = indexResult.db
    dataDb = dataResult.db
  })

  afterEach(() => {
    indexResult.close()
    dataResult.close()
  })

  it('returns notes, tasks and inbox items for a tag', () => {
    insertNote(indexDb, 'n1', 'Q3 kickoff')
    insertNoteTag(indexDb, 'n1', 'meetings')
    insertTask(dataDb, 't1', '1:1 with Ali')
    insertTaskTag(dataDb, 't1', 'meetings')
    const i1 = seedInboxItem(dataDb, { id: 'i1', title: 'Meeting notes' })
    seedInboxItemTags(dataDb, i1, ['meetings'])

    const items = listTagItems(indexDb, dataDb, 'meetings')

    expect(items.map((i) => i.kind).sort()).toEqual(['inbox', 'note', 'task'])
  })

  it('includes descendant tags', () => {
    insertNote(indexDb, 'n1', 'Own')
    insertNoteTag(indexDb, 'n1', 'work')
    insertNote(indexDb, 'n2', 'Child')
    insertNoteTag(indexDb, 'n2', 'work/meetings')

    expect(
      listTagItems(indexDb, dataDb, 'work')
        .map((i) => i.id)
        .sort()
    ).toEqual(['n1', 'n2'])
  })

  it('does not match a tag that merely shares a prefix', () => {
    insertNote(indexDb, 'n1', 'Own')
    insertNoteTag(indexDb, 'n1', 'work')
    insertNote(indexDb, 'n2', 'Other')
    insertNoteTag(indexDb, 'n2', 'workshop')

    expect(listTagItems(indexDb, dataDb, 'work').map((i) => i.id)).toEqual(['n1'])
  })

  it('matches case-insensitively', () => {
    insertNote(indexDb, 'n1', 'Own')
    insertNoteTag(indexDb, 'n1', 'Work')

    expect(listTagItems(indexDb, dataDb, 'work')).toHaveLength(1)
  })

  it('returns an empty array for an unused tag', () => {
    expect(listTagItems(indexDb, dataDb, 'nothing')).toEqual([])
  })
})
