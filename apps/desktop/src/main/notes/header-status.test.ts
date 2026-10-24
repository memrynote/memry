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
import { fillHeaderStatus, syncHeaderStatus, syncHeaderStatusForTask } from './header-status'

const mocks = vi.hoisted(() => ({
  dataDb: {} as unknown,
  indexDb: {} as unknown,
  content: '',
  merge: vi.fn(async (_noteId: string, _values: Record<string, unknown>) => ({
    success: true as const
  }))
}))
vi.mock('../database', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => mocks.indexDb
}))
vi.mock('../vault/notes-crud', () => ({
  getNoteById: async (id: string) => ({ id, content: mocks.content })
}))
vi.mock('./entity-properties', () => ({ mergeEntityProperties: mocks.merge }))

type TaskState = 'todo' | 'doing' | 'done' | 'reopened' | 'completed-on-todo' | 'unfiled-done'

describe('a note header status written from the tasks in its body', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  const addTask = (id: string, state: TaskState, sourceNoteId = 'n1'): void => {
    const statusId = {
      todo: 's-todo',
      'completed-on-todo': 's-todo',
      doing: 's-doing',
      done: 's-done',
      reopened: 's-doing',
      'unfiled-done': null
    }[state]
    insertTask(asClientDb(data.db), {
      id,
      projectId: 'p1',
      title: id,
      statusId,
      sourceNoteId,
      // `reopened` is a done task moved back to In Progress by a picker that
      // leaves completedAt behind.
      completedAt: ['done', 'reopened', 'completed-on-todo', 'unfiled-done'].includes(state)
        ? new Date().toISOString()
        : null
    })
  }
  const holding = (...ids: string[]): void => {
    mocks.content = ids.map((id) => `- [ ] ${id} {task:${id}}`).join('\n')
  }
  const storeStatus = (value: unknown = 'Not started', name = 'status', type = 'status'): void =>
    setNoteProperties(index.db, 'n1', { [name]: value }, () => type)
  const written = (): unknown => mocks.merge.mock.calls[0]?.[1]

  beforeEach(() => {
    mocks.merge.mockClear()
    mocks.content = ''
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

  it('writes Not started, In Progress or Done by the rule', async () => {
    storeStatus('Done')
    addTask('a', 'todo')
    addTask('b', 'todo')
    holding('a', 'b')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'Not started' })

    mocks.merge.mockClear()
    storeStatus('Not started')
    addTask('c', 'doing')
    holding('a', 'c')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'In Progress' })

    mocks.merge.mockClear()
    addTask('d', 'done')
    addTask('e', 'done')
    holding('d', 'e')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'Done' })
  })

  it('writes nothing when the stored status already is the derived one', async () => {
    storeStatus('Done')
    addTask('a', 'done')
    holding('a')
    await syncHeaderStatus('n1')
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('writes over a status the user picked, because a task changed after it', async () => {
    storeStatus('Abandoned')
    addTask('a', 'done')
    holding('a')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'Done' })
  })

  it('reads a done task moved back to In Progress as in progress, though completedAt is left', async () => {
    storeStatus('Done')
    addTask('a', 'done')
    addTask('b', 'reopened')
    holding('a', 'b')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'In Progress' })
  })

  it('reads a task completed without moving its status as done', async () => {
    storeStatus()
    addTask('a', 'completed-on-todo')
    addTask('b', 'unfiled-done')
    holding('a', 'b')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'Done' })
  })

  it('follows a property the picker named Status and keeps that name', async () => {
    storeStatus('Not started', 'Status')
    addTask('a', 'done')
    holding('a')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ Status: 'Done' })
  })

  it('counts the task that just changed before the editor has written it to the file', async () => {
    storeStatus('Not started')
    addTask('a', 'done')
    holding()
    await syncHeaderStatus('n1', { alsoTaskId: 'a' })
    expect(written()).toEqual({ status: 'Done' })
  })

  it('skips a task whose row has not arrived and leaves a note of only those alone', async () => {
    storeStatus()
    addTask('a', 'done')
    holding('a', 'missing')
    await syncHeaderStatus('n1')
    expect(written()).toEqual({ status: 'Done' })

    mocks.merge.mockClear()
    holding('missing')
    await syncHeaderStatus('n1')
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('leaves a note without tasks, or a property of another type, alone', async () => {
    storeStatus('Abandoned')
    holding()
    await syncHeaderStatus('n1')
    storeStatus('Open', 'status', 'select')
    addTask('a', 'done')
    holding('a')
    await syncHeaderStatus('n1')
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('fills a status property the user just added but leaves a chosen value', async () => {
    storeStatus(null)
    addTask('a', 'doing')
    holding('a')
    fillHeaderStatus('n1')
    await vi.waitFor(() => expect(written()).toEqual({ status: 'In Progress' }))

    mocks.merge.mockClear()
    storeStatus('Done')
    fillHeaderStatus('n1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  it('reaches the notes a task is sourced from or linked to, once each', async () => {
    storeStatus()
    addTask('a', 'done')
    holding('a')
    syncHeaderStatusForTask({ id: 'a', sourceNoteId: 'n1', linkedNoteIds: ['n1', 'n1'] })
    await vi.waitFor(() => expect(mocks.merge).toHaveBeenCalledTimes(1))
    expect(mocks.merge.mock.calls[0]?.[0]).toBe('n1')
  })
})
