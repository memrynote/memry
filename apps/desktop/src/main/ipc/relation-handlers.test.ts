import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabases, sql, type TestDb } from '@tests/utils/test-db'
import { resolveRefs } from './relation-handlers'

function insertNote(db: TestDb, id: string, title: string, fileType = 'markdown'): void {
  db.run(sql`
    INSERT INTO note_cache (
      id, path, title, file_type, content_hash, word_count, character_count, created_at, modified_at
    )
    VALUES (
      ${id}, ${`notes/${id}.md`}, ${title}, ${fileType}, ${`hash-${id}`}, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `)
}

function insertTask(db: TestDb, id: string, title: string): void {
  db.run(sql`
    INSERT OR IGNORE INTO projects (id, name, position) VALUES ('project-1', 'Project', 0)
  `)
  db.run(sql`
    INSERT INTO tasks (id, project_id, title, position) VALUES (${id}, 'project-1', ${title}, 0)
  `)
}

function insertEvent(db: TestDb, id: string, title: string): void {
  db.run(sql`
    INSERT INTO calendar_events (id, title, start_at)
    VALUES (${id}, ${title}, '2026-05-10T12:00:00.000Z')
  `)
}

describe('properties:resolveRefs', () => {
  let indexDb: TestDb
  let dataDb: TestDb
  let closeAll: () => void

  beforeEach(() => {
    const dbs = createTestDatabases()
    indexDb = dbs.index.db
    dataDb = dbs.data.db
    closeAll = dbs.closeAll

    insertNote(indexDb, 'nte_1', 'Richard Doe')
    insertNote(indexDb, 'nte_pdf', 'contract.pdf', 'pdf')
    insertTask(dataDb, 'tsk_1', 'Call Richard')
    insertEvent(dataDb, 'evt_1', 'Lunch')
  })

  afterEach(() => {
    closeAll()
  })

  it('resolves a note, a task and an event', async () => {
    const result = await resolveRefs(indexDb, dataDb, [
      'memry://note/nte_1',
      'memry://task/tsk_1',
      'memry://event/evt_1'
    ])
    expect(result.map((r) => r.title)).toEqual(['Richard Doe', 'Call Richard', 'Lunch'])
    expect(result.every((r) => r.exists)).toBe(true)
  })

  it('marks missing targets as non-existent without throwing', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['memry://note/nte_gone'])
    expect(ref.exists).toBe(false)
    expect(ref.uri).toBe('memry://note/nte_gone')
  })

  it('marks malformed URIs as non-existent without throwing', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['not-a-uri'])
    expect(ref.exists).toBe(false)
  })

  it('preserves input order and length', async () => {
    const uris = ['memry://task/tsk_1', 'memry://note/nte_1']
    const result = await resolveRefs(indexDb, dataDb, uris)
    expect(result.map((r) => r.uri)).toEqual(uris)
  })

  it('returns fileType for file notes', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['memry://note/nte_pdf'])
    expect(ref.fileType).toBe('pdf')
  })

  it('issues at most one query per kind regardless of how many URIs are requested', async () => {
    const indexSelectSpy = vi.spyOn(indexDb, 'select')
    const dataSelectSpy = vi.spyOn(dataDb, 'select')

    const manyUris = [
      'memry://note/nte_1',
      'memry://note/nte_1',
      'memry://note/nte_1',
      'memry://task/tsk_1',
      'memry://task/tsk_1',
      'memry://event/evt_1',
      'memry://event/evt_1',
      'memry://event/evt_1',
      'memry://event/evt_1'
    ]

    await resolveRefs(indexDb, dataDb, manyUris)

    // One query for notes (index db) + one for tasks + one for events (data db) = 3 total,
    // no matter how many URIs of each kind were requested.
    expect(indexSelectSpy).toHaveBeenCalledTimes(1)
    expect(dataSelectSpy).toHaveBeenCalledTimes(2)
  })
})
