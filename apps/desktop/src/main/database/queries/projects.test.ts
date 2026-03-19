import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, sql } from '@tests/utils/test-db'
import {
  insertProject,
  updateProject,
  deleteProject,
  getProjectById,
  projectExists,
  getInboxProject,
  listProjects,
  getProjectsWithStats,
  archiveProject,
  unarchiveProject,
  reorderProjects,
  getNextProjectPosition,
  insertStatus,
  updateStatus,
  deleteStatus,
  getStatusById,
  getStatusesByProject,
  getDefaultStatus,
  getDoneStatus,
  getEquivalentStatus,
  reorderStatuses,
  setDefaultStatus,
  setDoneStatus,
  createDefaultStatuses,
  countTasksInStatus,
  getProjectWithStatuses,
  getProjectsWithStatuses
} from './projects'
import { insertTask } from './tasks'

const BASE_TIME = new Date('2026-01-15T10:00:00.000Z')

describe('projects queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
    dbResult.close()
  })

  it('inserts projects and retrieves them by id', () => {
    const project = insertProject(db, {
      id: 'project-1',
      name: 'Project 1',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })

    expect(project.id).toBe('project-1')
    expect(getProjectById(db, project.id)?.name).toBe('Project 1')
    expect(projectExists(db, project.id)).toBe(true)
  })

  it('updates and deletes projects with cascading data', () => {
    insertProject(db, {
      id: 'project-2',
      name: 'Project 2',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertStatus(db, {
      id: 'status-2',
      projectId: 'project-2',
      name: 'To Do',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })
    insertTask(db, {
      id: 'task-2',
      projectId: 'project-2',
      statusId: 'status-2',
      title: 'Task 2',
      position: 0
    })

    const updated = updateProject(db, 'project-2', { name: 'Renamed' })
    expect(updated?.name).toBe('Renamed')

    deleteProject(db, 'project-2')
    expect(projectExists(db, 'project-2')).toBe(false)
    expect(db.all(sql`SELECT * FROM statuses`)).toHaveLength(0)
    expect(db.all(sql`SELECT * FROM tasks`)).toHaveLength(0)
  })

  it('returns inbox project and lists non-archived projects', () => {
    insertProject(db, {
      id: 'inbox',
      name: 'Inbox',
      color: '#6366f1',
      position: 0,
      isInbox: true
    })
    insertProject(db, {
      id: 'project-3',
      name: 'Project 3',
      color: '#6366f1',
      position: 1,
      isInbox: false
    })
    insertProject(db, {
      id: 'project-4',
      name: 'Archived',
      color: '#6366f1',
      position: 2,
      isInbox: false,
      archivedAt: '2026-01-10T10:00:00.000Z'
    })

    expect(getInboxProject(db)?.id).toBe('inbox')
    const listed = listProjects(db)
    expect(listed.map((p) => p.id)).toEqual(['inbox', 'project-3'])
  })

  it('computes project stats', () => {
    insertProject(db, {
      id: 'project-5',
      name: 'Stats',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })

    insertTask(db, {
      id: 'task-5a',
      projectId: 'project-5',
      statusId: null,
      title: 'Overdue',
      dueDate: '2026-01-10',
      position: 0
    })
    insertTask(db, {
      id: 'task-5b',
      projectId: 'project-5',
      statusId: null,
      title: 'Complete',
      completedAt: '2026-01-12T10:00:00.000Z',
      position: 1
    })

    const stats = getProjectsWithStats(db)
    const projectStats = stats.find((p) => p.id === 'project-5')
    expect(projectStats?.taskCount).toBe(2)
    expect(projectStats?.completedCount).toBe(1)
    expect(projectStats?.overdueCount).toBe(1)
  })

  it('archives and unarchives projects', () => {
    insertProject(db, {
      id: 'project-6',
      name: 'Archive Me',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })

    const archived = archiveProject(db, 'project-6')
    expect(archived?.archivedAt).toBeTruthy()

    const unarchived = unarchiveProject(db, 'project-6')
    expect(unarchived?.archivedAt).toBeNull()
  })

  it('reorders projects and computes next position', () => {
    insertProject(db, {
      id: 'project-7',
      name: 'Project 7',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertProject(db, {
      id: 'project-8',
      name: 'Project 8',
      color: '#6366f1',
      position: 1,
      isInbox: false
    })

    reorderProjects(db, ['project-8', 'project-7'], [0, 1])
    const ordered = listProjects(db)
    expect(ordered.map((p) => p.id)).toEqual(['project-8', 'project-7'])

    expect(getNextProjectPosition(db)).toBe(2)
  })

  it('manages status CRUD operations', () => {
    insertProject(db, {
      id: 'project-9',
      name: 'Project 9',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })

    const status = insertStatus(db, {
      id: 'status-9',
      projectId: 'project-9',
      name: 'To Do',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })

    const updated = updateStatus(db, status.id, { name: 'Updated' })
    expect(updated?.name).toBe('Updated')

    insertTask(db, {
      id: 'task-9',
      projectId: 'project-9',
      statusId: status.id,
      title: 'Task 9',
      position: 0
    })

    deleteStatus(db, status.id)
    expect(getStatusById(db, status.id)).toBeUndefined()
    const task = db.get<{ status_id: string | null }>(sql`
      SELECT status_id FROM tasks WHERE id = 'task-9'
    `)
    expect(task?.status_id).toBeNull()
  })

  it('returns status collections and defaults', () => {
    insertProject(db, {
      id: 'project-10',
      name: 'Project 10',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertStatus(db, {
      id: 'status-10a',
      projectId: 'project-10',
      name: 'Todo',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })
    insertStatus(db, {
      id: 'status-10b',
      projectId: 'project-10',
      name: 'Done',
      color: '#22c55e',
      position: 1,
      isDefault: false,
      isDone: true
    })

    expect(getStatusesByProject(db, 'project-10')).toHaveLength(2)
    expect(getDefaultStatus(db, 'project-10')?.id).toBe('status-10a')
    expect(getDoneStatus(db, 'project-10')?.id).toBe('status-10b')
  })

  it('resolves equivalent statuses across projects', () => {
    insertProject(db, {
      id: 'project-11',
      name: 'Project 11',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertProject(db, {
      id: 'project-12',
      name: 'Project 12',
      color: '#6366f1',
      position: 1,
      isInbox: false
    })

    const todo = insertStatus(db, {
      id: 'status-11a',
      projectId: 'project-11',
      name: 'Todo',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })
    const done = insertStatus(db, {
      id: 'status-11b',
      projectId: 'project-11',
      name: 'Done',
      color: '#22c55e',
      position: 1,
      isDefault: false,
      isDone: true
    })

    insertStatus(db, {
      id: 'status-12a',
      projectId: 'project-12',
      name: 'Todo',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })
    insertStatus(db, {
      id: 'status-12b',
      projectId: 'project-12',
      name: 'In Progress',
      color: '#F59E0B',
      position: 1,
      isDefault: false,
      isDone: false
    })
    insertStatus(db, {
      id: 'status-12c',
      projectId: 'project-12',
      name: 'Done',
      color: '#22c55e',
      position: 2,
      isDefault: false,
      isDone: true
    })

    expect(getEquivalentStatus(db, 'project-12', getStatusById(db, todo.id))?.id).toBe('status-12a')
    expect(getEquivalentStatus(db, 'project-12', getStatusById(db, done.id))?.id).toBe('status-12c')
    const inProgress = getStatusById(db, 'status-12b')
    expect(getEquivalentStatus(db, 'project-11', inProgress)?.id).toBe('status-11a')
  })

  it('reorders statuses and updates default/done flags', () => {
    insertProject(db, {
      id: 'project-13',
      name: 'Project 13',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertStatus(db, {
      id: 'status-13a',
      projectId: 'project-13',
      name: 'Todo',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })
    insertStatus(db, {
      id: 'status-13b',
      projectId: 'project-13',
      name: 'Done',
      color: '#22c55e',
      position: 1,
      isDefault: false,
      isDone: true
    })

    reorderStatuses(db, ['status-13b', 'status-13a'], [0, 1])
    const statuses = getStatusesByProject(db, 'project-13')
    expect(statuses.map((s) => s.id)).toEqual(['status-13b', 'status-13a'])

    setDefaultStatus(db, 'project-13', 'status-13b')
    expect(getDefaultStatus(db, 'project-13')?.id).toBe('status-13b')

    setDoneStatus(db, 'project-13', 'status-13a')
    expect(getDoneStatus(db, 'project-13')?.id).toBe('status-13a')
  })

  it('creates default statuses and counts tasks by status', () => {
    insertProject(db, {
      id: 'project-14',
      name: 'Project 14',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })

    const statuses = createDefaultStatuses(db, 'project-14')
    expect(statuses).toHaveLength(3)
    expect(getDefaultStatus(db, 'project-14')?.name).toBe('To Do')
    expect(getDoneStatus(db, 'project-14')?.name).toBe('Done')

    insertTask(db, {
      id: 'task-14',
      projectId: 'project-14',
      statusId: statuses[0].id,
      title: 'Task 14',
      position: 0
    })
    expect(countTasksInStatus(db, statuses[0].id)).toBe(1)
  })

  it('returns projects with statuses included', () => {
    insertProject(db, {
      id: 'project-15',
      name: 'Project 15',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
    insertStatus(db, {
      id: 'status-15',
      projectId: 'project-15',
      name: 'Todo',
      color: '#6b7280',
      position: 0,
      isDefault: true,
      isDone: false
    })

    const projectWithStatuses = getProjectWithStatuses(db, 'project-15')
    expect(projectWithStatuses?.statuses).toHaveLength(1)

    const all = getProjectsWithStatuses(db)
    expect(all[0].statuses.length).toBeGreaterThan(0)
  })
})
