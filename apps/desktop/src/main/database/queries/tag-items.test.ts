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
import { itemTagsMatch, listTagItems } from './tag-items'

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

  it('includes descendant tags and excludes prefix collisions for tasks', () => {
    insertTask(dataDb, 't1', 'Own')
    insertTaskTag(dataDb, 't1', 'work')
    insertTask(dataDb, 't2', 'Child')
    insertTaskTag(dataDb, 't2', 'work/meetings')
    insertTask(dataDb, 't3', 'Decoy')
    insertTaskTag(dataDb, 't3', 'workshop')

    const items = listTagItems(indexDb, dataDb, 'work').filter((i) => i.kind === 'task')

    expect(items.map((i) => i.id).sort()).toEqual(['t1', 't2'])
  })

  it('includes descendant tags and excludes prefix collisions for inbox items', () => {
    const i1 = seedInboxItem(dataDb, { id: 'i1', title: 'Own' })
    seedInboxItemTags(dataDb, i1, ['work'])
    const i2 = seedInboxItem(dataDb, { id: 'i2', title: 'Child' })
    seedInboxItemTags(dataDb, i2, ['work/meetings'])
    const i3 = seedInboxItem(dataDb, { id: 'i3', title: 'Decoy' })
    seedInboxItemTags(dataDb, i3, ['workshop'])

    const items = listTagItems(indexDb, dataDb, 'work').filter((i) => i.kind === 'inbox')

    expect(items.map((i) => i.id).sort()).toEqual(['i1', 'i2'])
  })

  it('matches case-insensitively', () => {
    insertNote(indexDb, 'n1', 'Own')
    insertNoteTag(indexDb, 'n1', 'Work')

    expect(listTagItems(indexDb, dataDb, 'work')).toHaveLength(1)
  })

  it('returns an empty array for an unused tag', () => {
    expect(listTagItems(indexDb, dataDb, 'nothing')).toEqual([])
  })

  describe('AND semantics (andTags)', () => {
    function seedAndFixture(): void {
      insertNote(indexDb, 'n1', 'Both')
      insertNoteTag(indexDb, 'n1', 'work')
      insertNoteTag(indexDb, 'n1', 'urgent')
      insertNote(indexDb, 'n2', 'Only work')
      insertNoteTag(indexDb, 'n2', 'work')
      insertNote(indexDb, 'n3', 'All three')
      insertNoteTag(indexDb, 'n3', 'work')
      insertNoteTag(indexDb, 'n3', 'urgent')
      insertNoteTag(indexDb, 'n3', 'travel')
    }

    it('an empty andTags list is the unfiltered single-tag query', () => {
      seedAndFixture()

      expect(
        listTagItems(indexDb, dataDb, 'work', [])
          .map((i) => i.id)
          .sort()
      ).toEqual(['n1', 'n2', 'n3'])
    })

    it('keeps only items carrying every selected tag', () => {
      seedAndFixture()

      expect(
        listTagItems(indexDb, dataDb, 'work', ['urgent'])
          .map((i) => i.id)
          .sort()
      ).toEqual(['n1', 'n3'])
    })

    it('narrows further as a third tag is added', () => {
      seedAndFixture()

      expect(listTagItems(indexDb, dataDb, 'work', ['urgent', 'travel']).map((i) => i.id)).toEqual([
        'n3'
      ])
    })

    it('normalizes the ANDed tags the same way as the primary tag', () => {
      insertNote(indexDb, 'n1', 'Mixed case')
      insertNoteTag(indexDb, 'n1', 'Work')
      insertNoteTag(indexDb, 'n1', 'Urgent')

      expect(listTagItems(indexDb, dataDb, 'work', ['  URGENT '])).toHaveLength(1)
    })

    it('matches descendants of an ANDed tag but not prefix collisions', () => {
      insertNote(indexDb, 'n1', 'Descendant')
      insertNoteTag(indexDb, 'n1', 'work')
      insertNoteTag(indexDb, 'n1', 'project/alpha')
      insertNote(indexDb, 'n2', 'Prefix decoy')
      insertNoteTag(indexDb, 'n2', 'work')
      insertNoteTag(indexDb, 'n2', 'projection')

      expect(listTagItems(indexDb, dataDb, 'work', ['project']).map((i) => i.id)).toEqual(['n1'])
    })

    it('ignores the primary tag repeated in andTags', () => {
      seedAndFixture()

      expect(
        listTagItems(indexDb, dataDb, 'work', ['WORK'])
          .map((i) => i.id)
          .sort()
      ).toEqual(['n1', 'n2', 'n3'])
    })

    it('ANDs across sources', () => {
      insertTask(dataDb, 't1', 'Both')
      insertTaskTag(dataDb, 't1', 'work')
      insertTaskTag(dataDb, 't1', 'urgent')
      insertTask(dataDb, 't2', 'Only work')
      insertTaskTag(dataDb, 't2', 'work')
      const i1 = seedInboxItem(dataDb, { id: 'i1', title: 'Both' })
      seedInboxItemTags(dataDb, i1, ['work', 'urgent'])
      const i2 = seedInboxItem(dataDb, { id: 'i2', title: 'Only work' })
      seedInboxItemTags(dataDb, i2, ['work'])

      expect(
        listTagItems(indexDb, dataDb, 'work', ['urgent'])
          .map((i) => i.id)
          .sort()
      ).toEqual(['i1', 't1'])
    })
  })
})

describe('itemTagsMatch', () => {
  it('matches exactly, and by descendant, never by bare prefix', () => {
    expect(itemTagsMatch(['work'], 'work')).toBe(true)
    expect(itemTagsMatch(['Work/Meetings'], 'work')).toBe(true)
    expect(itemTagsMatch(['workshop'], 'work')).toBe(false)
    expect(itemTagsMatch([], 'work')).toBe(false)
  })
})
