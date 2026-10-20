import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertProject, insertStatus } from '../database/queries/projects'
import { insertTask } from '../database/queries/tasks'
import { insertNoteCache } from '../database/queries/notes'
import { setNoteProperties } from '../database/queries/notes/property-queries'
import { deriveNoteHeaderStatus, withDerivedHeaderStatus } from './header-status'

const mocks = vi.hoisted(() => ({ dataDb: {} as unknown, indexDb: {} as unknown }))
vi.mock('../database', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => mocks.indexDb
}))

describe('header status derived from the tasks in a note body', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  const addTask = (id: string, state: 'todo' | 'doing' | 'done' | 'completed'): void => {
    insertTask(asClientDb(data.db), {
      id,
      projectId: 'p1',
      title: id,
      statusId: { todo: 's-todo', doing: 's-doing', done: 's-done', completed: 's-todo' }[state],
      completedAt: state === 'completed' ? new Date().toISOString() : null
    })
  }
  const body = (...ids: string[]): string => ids.map((id) => `- [ ] ${id} {task:${id}}`).join('\n')
  const storeStatus = (value: unknown = 'Not started', type = 'status' as const): void =>
    setNoteProperties(index.db as never, 'n1', { status: value }, () => type)

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    mocks.dataDb = asClientDb(data.db)
    mocks.indexDb = index.db
    insertNoteCache(index.db, {
      id: 'n1',
      path: 'notes/n1.md',
      title: 'N1',
      contentHash: 'h',
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-10T00:00:00.000Z'
    })
    const db = asClientDb(data.db)
    insertProject(db, { id: 'p1', name: 'P' })
    insertStatus(db, { id: 's-todo', projectId: 'p1', name: 'To do', position: 0, isDefault: true })
    insertStatus(db, { id: 's-doing', projectId: 'p1', name: 'Doing', position: 1 })
    insertStatus(db, { id: 's-done', projectId: 'p1', name: 'Done', position: 2, isDone: true })
  })

  afterEach(() => {
    data.close()
    index.close()
  })

  it('reads all to-do tasks as Not started', () => {
    storeStatus('Done')
    addTask('a', 'todo')
    addTask('b', 'todo')
    expect(deriveNoteHeaderStatus('n1', body('a', 'b'))).toBe('Not started')
  })

  it('reads a task in progress, or a mix of done and open, as In Progress', () => {
    storeStatus()
    addTask('a', 'todo')
    addTask('b', 'doing')
    addTask('c', 'completed')
    expect(deriveNoteHeaderStatus('n1', body('a', 'b'))).toBe('In Progress')
    expect(deriveNoteHeaderStatus('n1', body('a', 'c'))).toBe('In Progress')
  })

  it('reads all done tasks as Done', () => {
    storeStatus()
    addTask('a', 'done')
    addTask('b', 'completed')
    expect(deriveNoteHeaderStatus('n1', body('a', 'b'))).toBe('Done')
  })

  it('leaves a note without tasks to its stored status', () => {
    storeStatus('Abandoned')
    expect(withDerivedHeaderStatus('n1', '# Plan', { status: 'Abandoned' })).toEqual({
      status: 'Abandoned'
    })
  })

  it('skips a task whose row has not arrived and leaves a note of only those alone', () => {
    storeStatus()
    addTask('a', 'done')
    expect(deriveNoteHeaderStatus('n1', body('a', 'missing'))).toBe('Done')
    expect(deriveNoteHeaderStatus('n1', body('missing'))).toBeNull()
  })

  it('leaves a status that is not a status property alone', () => {
    storeStatus('Open', 'select' as never)
    addTask('a', 'done')
    expect(deriveNoteHeaderStatus('n1', body('a'))).toBeNull()
  })

  it('replaces only the status in the properties it returns', () => {
    storeStatus()
    addTask('a', 'done')
    expect(
      withDerivedHeaderStatus('n1', body('a'), { status: 'Not started', owner: 'Kaan' })
    ).toEqual({
      status: 'Done',
      owner: 'Kaan'
    })
  })
})
