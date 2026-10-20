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
import { withDerivedHeaderStatus } from './header-status'

const mocks = vi.hoisted(() => ({ dataDb: {} as unknown, indexDb: {} as unknown }))
vi.mock('../database', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => mocks.indexDb
}))

type TaskState =
  'todo' | 'doing' | 'done' | 'reopened' | 'completed-on-todo' | 'unfiled' | 'unfiled-done'

describe('header status derived from the tasks in a note body', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  const addTask = (id: string, state: TaskState): void => {
    const statusId = {
      todo: 's-todo',
      'completed-on-todo': 's-todo',
      doing: 's-doing',
      done: 's-done',
      reopened: 's-doing'
    }[state as 'todo' | 'completed-on-todo' | 'doing' | 'done' | 'reopened']
    insertTask(asClientDb(data.db), {
      id,
      projectId: 'p1',
      title: id,
      statusId: statusId ?? null,
      // `reopened` is a done task whose status the inline picker moved to In
      // Progress: the picker leaves completedAt behind.
      completedAt: ['done', 'reopened', 'completed-on-todo', 'unfiled-done'].includes(state)
        ? new Date().toISOString()
        : null
    })
  }
  const body = (...ids: string[]): string => ids.map((id) => `- [ ] ${id} {task:${id}}`).join('\n')
  const storeStatus = (value: unknown = 'Not started', name = 'status', type = 'status'): void =>
    setNoteProperties(index.db as never, 'n1', { [name]: value }, () => type as never)
  const shown = (content: string, name = 'status'): unknown =>
    withDerivedHeaderStatus('n1', content, { [name]: 'stored' })[name]

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
    expect(shown(body('a', 'b'))).toBe('Not started')
  })

  it('reads a task in progress, or a mix of done and open, as In Progress', () => {
    storeStatus()
    addTask('a', 'todo')
    addTask('b', 'doing')
    addTask('c', 'done')
    expect(shown(body('a', 'b'))).toBe('In Progress')
    expect(shown(body('a', 'c'))).toBe('In Progress')
  })

  it('reads all done tasks as Done', () => {
    storeStatus()
    addTask('a', 'done')
    addTask('b', 'done')
    expect(shown(body('a', 'b'))).toBe('Done')
  })

  it('reads a done task moved back to In Progress as in progress, though completedAt is left', () => {
    storeStatus()
    addTask('a', 'done')
    addTask('b', 'reopened')
    expect(shown(body('a', 'b'))).toBe('In Progress')
    expect(shown(body('b'))).toBe('In Progress')
  })

  it('reads a task completed without moving its status (CLI, agents) as done', () => {
    storeStatus()
    addTask('a', 'completed-on-todo')
    addTask('b', 'completed-on-todo')
    expect(shown(body('a', 'b'))).toBe('Done')
  })

  it('reads a task with no status by whether it is completed', () => {
    storeStatus()
    addTask('a', 'unfiled')
    addTask('b', 'unfiled-done')
    expect(shown(body('a'))).toBe('Not started')
    expect(shown(body('b'))).toBe('Done')
  })

  it('follows a status property the picker named Status', () => {
    storeStatus('Not started', 'Status')
    addTask('a', 'done')
    expect(shown(body('a'), 'Status')).toBe('Done')
  })

  it('leaves a note without tasks to its stored status', () => {
    storeStatus('Abandoned')
    expect(shown('# Plan')).toBe('stored')
  })

  it('skips a task whose row has not arrived and leaves a note of only those alone', () => {
    storeStatus()
    addTask('a', 'done')
    expect(shown(body('a', 'missing'))).toBe('Done')
    expect(shown(body('missing'))).toBe('stored')
  })

  it('leaves a status that is not a status property alone', () => {
    storeStatus('Open', 'status', 'select')
    addTask('a', 'done')
    expect(shown(body('a'))).toBe('stored')
  })

  it('replaces only the status in the properties it returns', () => {
    storeStatus()
    addTask('a', 'done')
    expect(
      withDerivedHeaderStatus('n1', body('a'), { status: 'Not started', owner: 'Kaan' })
    ).toEqual({ status: 'Done', owner: 'Kaan' })
  })
})
