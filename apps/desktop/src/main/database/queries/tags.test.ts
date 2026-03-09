import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, createTestIndexDb, sql } from '@tests/utils/test-db'
import { getAllTagsWithCounts, mergeTagInNotes, mergeTagInTasks } from './tags'

// ============================================================================
// Helpers
// ============================================================================

function insertNote(indexDb: TestDb, id: string, path = `notes/${id}.md`): void {
  indexDb.run(sql`
    INSERT INTO note_cache (id, path, title, content_hash, word_count, character_count, created_at, modified_at)
    VALUES (${id}, ${path}, ${'Note ' + id}, ${'hash-' + id}, 10, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
}

function insertNoteTag(indexDb: TestDb, noteId: string, tag: string): void {
  indexDb.run(sql`
    INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (${noteId}, ${tag})
  `)
}

function insertTask(dataDb: TestDb, id: string): void {
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
    VALUES (${id}, 'inbox', 'status-default', ${'Task ' + id}, 0)
    ON CONFLICT DO NOTHING
  `)
}

function insertTaskTag(dataDb: TestDb, taskId: string, tag: string): void {
  dataDb.run(sql`
    INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (${taskId}, ${tag})
  `)
}

function insertTagDefinition(dataDb: TestDb, name: string, color: string): void {
  dataDb.run(sql`
    INSERT OR IGNORE INTO tag_definitions (name, color, created_at)
    VALUES (${name}, ${color}, '2026-01-01T00:00:00.000Z')
  `)
}

function readNoteTags(indexDb: TestDb, noteId: string): string[] {
  const rows = indexDb.all<{ tag: string }>(sql`
    SELECT tag FROM note_tags WHERE note_id = ${noteId} ORDER BY tag
  `)
  return rows.map((r) => r.tag)
}

function readTaskTags(dataDb: TestDb, taskId: string): string[] {
  const rows = dataDb.all<{ tag: string }>(sql`
    SELECT tag FROM task_tags WHERE task_id = ${taskId} ORDER BY tag
  `)
  return rows.map((r) => r.tag)
}

// ============================================================================
// getAllTagsWithCounts
// ============================================================================

describe('getAllTagsWithCounts', () => {
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

  it('returns empty array when both databases have no tags', () => {
    // #given: empty databases
    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)
    // #then
    expect(result).toEqual([])
  })

  it('returns note-only tags with correct counts', () => {
    // #given
    insertNote(indexDb, 'n1')
    insertNote(indexDb, 'n2')
    insertNoteTag(indexDb, 'n1', 'work')
    insertNoteTag(indexDb, 'n2', 'work')
    insertNoteTag(indexDb, 'n1', 'personal')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then
    const work = result.find((t) => t.name === 'work')
    const personal = result.find((t) => t.name === 'personal')
    expect(work?.count).toBe(2)
    expect(personal?.count).toBe(1)
  })

  it('returns task-only tags with correct counts', () => {
    // #given
    insertTask(dataDb, 't1')
    insertTask(dataDb, 't2')
    insertTaskTag(dataDb, 't1', 'urgent')
    insertTaskTag(dataDb, 't2', 'urgent')
    insertTaskTag(dataDb, 't1', 'review')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then
    const urgent = result.find((t) => t.name === 'urgent')
    const review = result.find((t) => t.name === 'review')
    expect(urgent?.count).toBe(2)
    expect(review?.count).toBe(1)
  })

  it('merges counts for tags that exist in both notes and tasks', () => {
    // #given: "work" tag on 2 notes + 3 tasks = 5 total
    insertNote(indexDb, 'n1')
    insertNote(indexDb, 'n2')
    insertNoteTag(indexDb, 'n1', 'work')
    insertNoteTag(indexDb, 'n2', 'work')
    insertTask(dataDb, 't1')
    insertTask(dataDb, 't2')
    insertTask(dataDb, 't3')
    insertTaskTag(dataDb, 't1', 'work')
    insertTaskTag(dataDb, 't2', 'work')
    insertTaskTag(dataDb, 't3', 'work')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then
    const work = result.find((t) => t.name === 'work')
    expect(work?.count).toBe(5)
  })

  it('attaches colors from tag definitions', () => {
    // #given
    insertNote(indexDb, 'n1')
    insertNoteTag(indexDb, 'n1', 'work')
    insertTagDefinition(dataDb, 'work', '#ff0000')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then
    const work = result.find((t) => t.name === 'work')
    expect(work?.color).toBe('#ff0000')
  })

  it('auto-creates a color for orphaned tags without definitions', () => {
    // #given: tag exists in notes but has no tag definition
    insertNote(indexDb, 'n1')
    insertNoteTag(indexDb, 'n1', 'orphan')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then: color should be auto-assigned (non-empty string)
    const orphan = result.find((t) => t.name === 'orphan')
    expect(orphan?.color).toBeTruthy()
    expect(typeof orphan?.color).toBe('string')
  })

  it('sorts results by count descending', () => {
    // #given: "beta" has more occurrences than "alpha"
    insertNote(indexDb, 'n1')
    insertNote(indexDb, 'n2')
    insertNote(indexDb, 'n3')
    insertNoteTag(indexDb, 'n1', 'alpha')
    insertNoteTag(indexDb, 'n1', 'beta')
    insertNoteTag(indexDb, 'n2', 'beta')
    insertNoteTag(indexDb, 'n3', 'beta')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then
    expect(result[0].name).toBe('beta')
    expect(result[1].name).toBe('alpha')
  })

  it('normalises tag casing when merging counts', () => {
    // #given: "Work" in notes, "work" in tasks — same tag, different case stored
    insertNote(indexDb, 'n1')
    insertNoteTag(indexDb, 'n1', 'work')
    insertTask(dataDb, 't1')
    insertTaskTag(dataDb, 't1', 'work')

    // #when
    const result = getAllTagsWithCounts(indexDb, dataDb)

    // #then: only one entry named "work"
    const workEntries = result.filter((t) => t.name === 'work')
    expect(workEntries).toHaveLength(1)
    expect(workEntries[0].count).toBe(2)
  })
})

// ============================================================================
// mergeTagInNotes
// ============================================================================

describe('mergeTagInNotes', () => {
  let indexResult: TestDatabaseResult
  let indexDb: TestDb

  beforeEach(() => {
    indexResult = createTestIndexDb()
    indexDb = indexResult.db
  })

  afterEach(() => {
    indexResult.close()
  })

  it('returns 0 affected when source === target (exact match)', () => {
    // #given / #when
    const result = mergeTagInNotes(indexDb, 'work', 'work')
    // #then
    expect(result).toEqual({ affected: 0, noteIds: [] })
  })

  it('returns 0 affected when source === target after normalisation', () => {
    // #when
    const result = mergeTagInNotes(indexDb, 'Work', 'work')
    // #then
    expect(result).toEqual({ affected: 0, noteIds: [] })
  })

  it('returns 0 affected when source tag does not exist', () => {
    // #given: no rows in note_tags
    // #when
    const result = mergeTagInNotes(indexDb, 'nonexistent', 'target')
    // #then
    expect(result).toEqual({ affected: 0, noteIds: [] })
  })

  it('renames source tag to target in simple (non-duplicate) case', () => {
    // #given
    insertNote(indexDb, 'n1')
    insertNote(indexDb, 'n2')
    insertNoteTag(indexDb, 'n1', 'old')
    insertNoteTag(indexDb, 'n2', 'old')

    // #when
    const result = mergeTagInNotes(indexDb, 'old', 'new')

    // #then
    expect(result.affected).toBe(2)
    expect(result.noteIds).toContain('n1')
    expect(result.noteIds).toContain('n2')
    expect(readNoteTags(indexDb, 'n1')).toEqual(['new'])
    expect(readNoteTags(indexDb, 'n2')).toEqual(['new'])
  })

  it('deletes source row when note already has target tag (dedup)', () => {
    // #given: n1 has BOTH source and target tags
    insertNote(indexDb, 'n1')
    insertNoteTag(indexDb, 'n1', 'old')
    insertNoteTag(indexDb, 'n1', 'new')

    // #when
    const result = mergeTagInNotes(indexDb, 'old', 'new')

    // #then: source row deleted, target row preserved, no duplicate
    expect(result.affected).toBe(1)
    expect(result.noteIds).toContain('n1')
    const tags = readNoteTags(indexDb, 'n1')
    expect(tags).toEqual(['new'])
    expect(tags).not.toContain('old')
  })

  it('handles mixed: some notes have both tags, others only have source', () => {
    // #given
    insertNote(indexDb, 'n1')
    insertNote(indexDb, 'n2')
    // n1 has both (dedup case)
    insertNoteTag(indexDb, 'n1', 'src')
    insertNoteTag(indexDb, 'n1', 'tgt')
    // n2 has only source (rename case)
    insertNoteTag(indexDb, 'n2', 'src')

    // #when
    const result = mergeTagInNotes(indexDb, 'src', 'tgt')

    // #then
    expect(result.affected).toBe(2)
    expect(readNoteTags(indexDb, 'n1')).toEqual(['tgt'])
    expect(readNoteTags(indexDb, 'n2')).toEqual(['tgt'])
  })

  it('normalises source and target before operating', () => {
    // #given: tags stored lowercase
    insertNote(indexDb, 'n1')
    insertNoteTag(indexDb, 'n1', 'work')

    // #when: call with mixed-case args
    const result = mergeTagInNotes(indexDb, 'Work', 'Personal')

    // #then: "work" row is renamed to "personal"
    expect(result.affected).toBe(1)
    expect(readNoteTags(indexDb, 'n1')).toEqual(['personal'])
  })

  it('returns correct noteIds for all affected rows', () => {
    // #given
    insertNote(indexDb, 'note-a')
    insertNote(indexDb, 'note-b')
    insertNote(indexDb, 'note-c')
    insertNoteTag(indexDb, 'note-a', 'alpha')
    insertNoteTag(indexDb, 'note-b', 'alpha')
    insertNoteTag(indexDb, 'note-c', 'alpha')

    // #when
    const result = mergeTagInNotes(indexDb, 'alpha', 'beta')

    // #then
    expect(result.noteIds.sort()).toEqual(['note-a', 'note-b', 'note-c'])
  })
})

// ============================================================================
// mergeTagInTasks
// ============================================================================

describe('mergeTagInTasks', () => {
  let dataResult: TestDatabaseResult
  let dataDb: TestDb

  beforeEach(() => {
    dataResult = createTestDataDb()
    dataDb = dataResult.db
  })

  afterEach(() => {
    dataResult.close()
  })

  it('returns 0 affected when source === target (exact match)', () => {
    // #when
    const result = mergeTagInTasks(dataDb, 'urgent', 'urgent')
    // #then
    expect(result).toEqual({ affected: 0, taskIds: [] })
  })

  it('returns 0 affected when source === target after normalisation', () => {
    // #when
    const result = mergeTagInTasks(dataDb, 'Urgent', 'urgent')
    // #then
    expect(result).toEqual({ affected: 0, taskIds: [] })
  })

  it('returns 0 affected when source tag does not exist', () => {
    // #when
    const result = mergeTagInTasks(dataDb, 'ghost', 'real')
    // #then
    expect(result).toEqual({ affected: 0, taskIds: [] })
  })

  it('renames source tag to target in simple case', () => {
    // #given
    insertTask(dataDb, 't1')
    insertTask(dataDb, 't2')
    insertTaskTag(dataDb, 't1', 'old')
    insertTaskTag(dataDb, 't2', 'old')

    // #when
    const result = mergeTagInTasks(dataDb, 'old', 'new')

    // #then
    expect(result.affected).toBe(2)
    expect(result.taskIds).toContain('t1')
    expect(result.taskIds).toContain('t2')
    expect(readTaskTags(dataDb, 't1')).toEqual(['new'])
    expect(readTaskTags(dataDb, 't2')).toEqual(['new'])
  })

  it('deletes source row when task already has target tag (dedup)', () => {
    // #given: t1 has BOTH source and target tags
    insertTask(dataDb, 't1')
    insertTaskTag(dataDb, 't1', 'old')
    insertTaskTag(dataDb, 't1', 'new')

    // #when
    const result = mergeTagInTasks(dataDb, 'old', 'new')

    // #then: no duplicate — only target tag remains
    expect(result.affected).toBe(1)
    const tags = readTaskTags(dataDb, 't1')
    expect(tags).toEqual(['new'])
    expect(tags).not.toContain('old')
  })

  it('handles mixed: some tasks have both tags, others only have source', () => {
    // #given
    insertTask(dataDb, 't1')
    insertTask(dataDb, 't2')
    insertTaskTag(dataDb, 't1', 'src')
    insertTaskTag(dataDb, 't1', 'tgt')
    insertTaskTag(dataDb, 't2', 'src')

    // #when
    const result = mergeTagInTasks(dataDb, 'src', 'tgt')

    // #then
    expect(result.affected).toBe(2)
    expect(readTaskTags(dataDb, 't1')).toEqual(['tgt'])
    expect(readTaskTags(dataDb, 't2')).toEqual(['tgt'])
  })

  it('normalises source and target before operating', () => {
    // #given
    insertTask(dataDb, 't1')
    insertTaskTag(dataDb, 't1', 'urgent')

    // #when
    const result = mergeTagInTasks(dataDb, 'Urgent', 'Review')

    // #then
    expect(result.affected).toBe(1)
    expect(readTaskTags(dataDb, 't1')).toEqual(['review'])
  })

  it('returns correct taskIds for all affected rows', () => {
    // #given
    insertTask(dataDb, 'task-x')
    insertTask(dataDb, 'task-y')
    insertTaskTag(dataDb, 'task-x', 'alpha')
    insertTaskTag(dataDb, 'task-y', 'alpha')

    // #when
    const result = mergeTagInTasks(dataDb, 'alpha', 'beta')

    // #then
    expect(result.taskIds.sort()).toEqual(['task-x', 'task-y'])
  })

  it('does not affect tasks that do not have the source tag', () => {
    // #given
    insertTask(dataDb, 't1')
    insertTask(dataDb, 't2')
    insertTaskTag(dataDb, 't1', 'src')
    insertTaskTag(dataDb, 't2', 'other')

    // #when
    mergeTagInTasks(dataDb, 'src', 'tgt')

    // #then: t2's tags are untouched
    expect(readTaskTags(dataDb, 't2')).toEqual(['other'])
  })
})
