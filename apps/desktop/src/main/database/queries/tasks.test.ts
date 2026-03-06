import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, sql } from '@tests/utils/test-db'
import type { NewTask } from '@memry/db-schema/schema/tasks'
import {
  insertTask,
  updateTask,
  deleteTask,
  getTaskById,
  taskExists,
  listTasks,
  countTasks,
  getTasksByProject,
  getSubtasks,
  countSubtasks,
  getTodayTasks,
  getTasksByDueDate,
  countOverdueTasksBeforeDate,
  getOverdueTasks,
  getUpcomingTasks,
  completeTask,
  uncompleteTask,
  archiveTask,
  unarchiveTask,
  moveTask,
  reorderTasks,
  duplicateTask,
  duplicateSubtask,
  setTaskTags,
  getTaskTags,
  getAllTaskTags,
  setTaskNotes,
  getTaskNoteIds,
  getTasksLinkedToNote,
  bulkCompleteTasks,
  bulkDeleteTasks,
  bulkMoveTasks,
  bulkArchiveTasks,
  getTaskStats,
  getNextTaskPosition
} from './tasks'

const BASE_TIME = new Date('2026-01-15T10:00:00.000Z')
const TODAY = '2026-01-15'
const YESTERDAY = '2026-01-14'
const TOMORROW = '2026-01-16'
const NEXT_WEEK = '2026-01-22'

describe('tasks queries', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string
  let statusTodo: string
  let statusDone: string

  const insertProject = (id: string, name = 'Project', position = 0, isInbox = 0) => {
    db.run(sql`
      INSERT INTO projects (id, name, color, position, is_inbox)
      VALUES (${id}, ${name}, '#6366f1', ${position}, ${isInbox})
    `)
    return id
  }

  const insertStatus = (
    project: string,
    id: string,
    {
      name = 'Status',
      position = 0,
      isDefault = 0,
      isDone = 0
    }: { name?: string; position?: number; isDefault?: number; isDone?: number } = {}
  ) => {
    db.run(sql`
      INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
      VALUES (${id}, ${project}, ${name}, '#6b7280', ${position}, ${isDefault}, ${isDone})
    `)
    return id
  }

  const createTask = (id: string, overrides: Partial<NewTask> = {}) => {
    const now = new Date().toISOString()
    return insertTask(db, {
      id,
      projectId,
      statusId: statusTodo,
      title: `Task ${id}`,
      position: 0,
      createdAt: now,
      modifiedAt: now,
      ...overrides
    })
  }

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    projectId = insertProject('project-1', 'Project 1', 0, 0)
    statusTodo = insertStatus(projectId, 'status-todo', {
      name: 'To Do',
      position: 0,
      isDefault: 1
    })
    statusDone = insertStatus(projectId, 'status-done', {
      name: 'Done',
      position: 1,
      isDone: 1
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    dbResult.close()
  })

  it('inserts tasks and retrieves them by id', () => {
    const task = createTask('task-1', { title: 'First Task' })
    const fetched = getTaskById(db, task.id)

    expect(fetched?.title).toBe('First Task')
    expect(taskExists(db, task.id)).toBe(true)
  })

  it('updates tasks with provided fields', () => {
    const task = createTask('task-2', { description: 'Old', priority: 1 })
    vi.setSystemTime(new Date('2026-01-16T12:00:00.000Z'))

    const updated = updateTask(db, task.id, {
      title: 'Updated Task',
      description: 'New',
      priority: 3,
      statusId: statusDone,
      dueDate: '2026-01-20',
      dueTime: '09:00',
      startDate: '2026-01-10',
      repeatConfig: JSON.stringify({ every: 'day' }),
      repeatFrom: 'dueDate'
    })

    expect(updated?.title).toBe('Updated Task')
    expect(updated?.description).toBe('New')
    expect(updated?.priority).toBe(3)
    expect(updated?.statusId).toBe(statusDone)
    expect(updated?.repeatFrom).toBe('dueDate')
    expect(updated?.modifiedAt).toBe('2026-01-16T12:00:00.000Z')
  })

  it('deletes tasks and cascades relations', () => {
    const task = createTask('task-3')
    setTaskTags(db, task.id, ['alpha', 'beta'])
    setTaskNotes(db, task.id, ['note-1', 'note-2'])

    expect(db.all(sql`SELECT * FROM task_tags`)).toHaveLength(2)
    expect(db.all(sql`SELECT * FROM task_notes`)).toHaveLength(2)

    deleteTask(db, task.id)

    expect(taskExists(db, task.id)).toBe(false)
    expect(db.all(sql`SELECT * FROM task_tags`)).toHaveLength(0)
    expect(db.all(sql`SELECT * FROM task_notes`)).toHaveLength(0)
  })

  it('lists tasks with pagination and default ordering', () => {
    createTask('task-4', { position: 0 })
    createTask('task-5', { position: 1 })
    createTask('task-6', { position: 2 })

    const result = listTasks(db, { limit: 2, offset: 1 })
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('task-5')
    expect(result[1].id).toBe('task-6')
  })

  it('filters tasks by project, status, and parent', () => {
    const projectTwo = insertProject('project-2', 'Project 2', 1, 0)
    const statusTwo = insertStatus(projectTwo, 'status-2', { name: 'Todo', isDefault: 1 })

    const parent = createTask('task-7', { position: 0 })
    createTask('task-8', { projectId: projectTwo, statusId: statusTwo })
    createTask('task-9', { parentId: parent.id })

    const byProject = listTasks(db, { projectId: projectTwo })
    expect(byProject.map((t) => t.id)).toEqual(['task-8'])

    const byStatus = listTasks(db, { statusId: statusTwo })
    expect(byStatus.map((t) => t.id)).toEqual(['task-8'])

    const byParent = listTasks(db, { parentId: parent.id })
    expect(byParent.map((t) => t.id)).toEqual(['task-9'])
  })

  it('filters tasks by completion and archive state', () => {
    createTask('task-10')
    createTask('task-11', { completedAt: '2026-01-10T10:00:00.000Z' })
    createTask('task-12', { archivedAt: '2026-01-10T10:00:00.000Z' })

    expect(listTasks(db).map((t) => t.id)).toEqual(['task-10'])
    expect(listTasks(db, { includeCompleted: true }).map((t) => t.id)).toContain('task-11')
    expect(listTasks(db, { includeArchived: true }).map((t) => t.id)).toContain('task-12')
  })

  it('filters tasks by due date ranges and tags', () => {
    const taskToday = createTask('task-13', { dueDate: TODAY, position: 0 })
    const taskFuture = createTask('task-14', { dueDate: TOMORROW, position: 1 })
    createTask('task-15', { dueDate: '2026-01-20', position: 2 })

    setTaskTags(db, taskToday.id, ['alpha', 'beta'])
    setTaskTags(db, taskFuture.id, ['alpha'])

    const dueBefore = listTasks(db, { dueBefore: TODAY })
    expect(dueBefore.map((t) => t.id)).toEqual(['task-13'])

    const dueAfter = listTasks(db, { dueAfter: TOMORROW })
    expect(dueAfter.map((t) => t.id)).toEqual(['task-14', 'task-15'])

    const tagged = listTasks(db, { tags: ['alpha', 'beta'] })
    expect(tagged.map((t) => t.id)).toEqual(['task-13'])

    const withSearch = listTasks(db, { search: 'Task' })
    expect(withSearch.length).toBeGreaterThan(0)
  })

  it('sorts tasks by due date, priority, and created date', () => {
    createTask('task-16', {
      dueDate: '2026-01-18',
      priority: 3,
      createdAt: '2026-01-10T10:00:00.000Z',
      modifiedAt: '2026-01-10T10:00:00.000Z'
    })
    createTask('task-17', {
      dueDate: '2026-01-16',
      priority: 1,
      createdAt: '2026-01-12T10:00:00.000Z',
      modifiedAt: '2026-01-12T10:00:00.000Z'
    })
    createTask('task-18', {
      dueDate: '2026-01-20',
      priority: 2,
      createdAt: '2026-01-11T10:00:00.000Z',
      modifiedAt: '2026-01-11T10:00:00.000Z'
    })

    const byDue = listTasks(db, { sortBy: 'dueDate' })
    expect(byDue[0].id).toBe('task-17')

    const byPriority = listTasks(db, { sortBy: 'priority', sortOrder: 'desc' })
    expect(byPriority[0].id).toBe('task-16')

    const byCreated = listTasks(db, { sortBy: 'created', sortOrder: 'asc' })
    expect(byCreated[0].id).toBe('task-16')
  })

  it('counts tasks with filters applied', () => {
    const otherProject = insertProject('project-3', 'Project 3', 2, 0)
    createTask('task-19')
    createTask('task-20', { projectId: otherProject })
    createTask('task-21', { completedAt: '2026-01-12T10:00:00.000Z' })
    createTask('task-22', { archivedAt: '2026-01-12T10:00:00.000Z' })

    expect(countTasks(db)).toBe(2)
    expect(countTasks(db, { projectId: otherProject })).toBe(1)
    expect(countTasks(db, { includeCompleted: true })).toBe(3)
    expect(countTasks(db, { includeArchived: true })).toBe(3)
  })

  it('retrieves tasks by project and subtasks', () => {
    const parent = createTask('task-23', { position: 0 })
    createTask('task-24', {
      parentId: parent.id,
      position: 0,
      completedAt: '2026-01-12T10:00:00.000Z'
    })
    createTask('task-25', { parentId: parent.id, position: 1 })

    const projectTasks = getTasksByProject(db, projectId)
    expect(projectTasks.map((t) => t.id)).toEqual(
      expect.arrayContaining(['task-23', 'task-24', 'task-25'])
    )

    const subtasks = getSubtasks(db, parent.id)
    expect(subtasks.map((t) => t.id)).toEqual(['task-24', 'task-25'])

    const counts = countSubtasks(db, parent.id)
    expect(counts.total).toBe(2)
    expect(counts.completed).toBe(1)
  })

  it('returns today and due-date specific task views', () => {
    createTask('task-26', { dueDate: TODAY, dueTime: '09:00', position: 1 })
    createTask('task-27', { dueDate: TODAY, dueTime: '08:00', position: 0 })
    createTask('task-28', { dueDate: TODAY, completedAt: '2026-01-12T10:00:00.000Z' })
    createTask('task-29', { dueDate: YESTERDAY })

    const todayTasks = getTodayTasks(db)
    expect(todayTasks.map((t) => t.id)).toEqual(['task-27', 'task-26'])

    const dueTasks = getTasksByDueDate(db, TODAY, false)
    expect(dueTasks.map((t) => t.id)).toEqual(['task-27', 'task-26'])

    const overdueCount = countOverdueTasksBeforeDate(db, TODAY)
    expect(overdueCount).toBe(1)
  })

  it('returns overdue and upcoming tasks', () => {
    createTask('task-30', { dueDate: YESTERDAY })
    createTask('task-31', { dueDate: TODAY })
    createTask('task-32', { dueDate: NEXT_WEEK })
    createTask('task-33', { dueDate: '2026-02-01' })

    const overdue = getOverdueTasks(db)
    expect(overdue.map((t) => t.id)).toEqual(['task-30'])

    const upcoming = getUpcomingTasks(db)
    expect(upcoming.map((t) => t.id)).toEqual(['task-31', 'task-32'])
  })

  it('completes and uncompletes tasks', () => {
    const task = createTask('task-34')
    const completed = completeTask(db, task.id)
    expect(completed?.completedAt).toBeTruthy()

    const uncompleted = uncompleteTask(db, task.id)
    expect(uncompleted?.completedAt).toBeNull()
  })

  it('archives and unarchives tasks', () => {
    const task = createTask('task-35')
    const archived = archiveTask(db, task.id)
    expect(archived?.archivedAt).toBeTruthy()

    const unarchived = unarchiveTask(db, task.id)
    expect(unarchived?.archivedAt).toBeNull()
  })

  it('moves tasks between projects and statuses', () => {
    const projectTwo = insertProject('project-4', 'Project 4', 3, 0)
    const statusTwo = insertStatus(projectTwo, 'status-4', { name: 'Alt', position: 0 })
    const task = createTask('task-36')

    const moved = moveTask(db, task.id, {
      projectId: projectTwo,
      statusId: statusTwo,
      parentId: 'parent-1',
      position: 5
    })

    expect(moved?.projectId).toBe(projectTwo)
    expect(moved?.statusId).toBe(statusTwo)
    expect(moved?.parentId).toBe('parent-1')
    expect(moved?.position).toBe(5)
  })

  it('reorders tasks by updating positions', () => {
    createTask('task-37', { position: 0 })
    createTask('task-38', { position: 1 })
    createTask('task-39', { position: 2 })

    reorderTasks(db, ['task-39', 'task-37', 'task-38'], [0, 1, 2])

    const ordered = listTasks(db, { sortBy: 'position' })
    expect(ordered.map((t) => t.id)).toEqual(['task-39', 'task-37', 'task-38'])
  })

  it('duplicates tasks and subtasks', () => {
    const task = createTask('task-40', { title: 'Original Task', position: 2 })
    const duplicate = duplicateTask(db, task.id, 'task-41')

    expect(duplicate?.title).toBe('Copy of Original Task')
    expect(duplicate?.position).toBe(task.position + 1)

    const parent = createTask('task-42', { title: 'Parent' })
    const subtask = createTask('task-43', { title: 'Child', parentId: parent.id })
    const subDuplicate = duplicateSubtask(db, subtask.id, 'task-44', 'task-45')

    expect(subDuplicate?.title).toBe('Child')
    expect(subDuplicate?.parentId).toBe('task-45')
  })

  it('manages task tags and counts', () => {
    const task = createTask('task-46')
    setTaskTags(db, task.id, ['Alpha', 'Beta'])

    expect(getTaskTags(db, task.id).sort()).toEqual(['alpha', 'beta'])

    const counts = getAllTaskTags(db)
    expect(counts).toEqual(
      expect.arrayContaining([
        { tag: 'alpha', count: 1 },
        { tag: 'beta', count: 1 }
      ])
    )
  })

  it('manages task note links', () => {
    const task = createTask('task-47')
    setTaskNotes(db, task.id, ['note-1', 'note-2'])

    expect(getTaskNoteIds(db, task.id).sort()).toEqual(['note-1', 'note-2'])

    const linked = getTasksLinkedToNote(db, 'note-1')
    expect(linked.map((t) => t.id)).toEqual(['task-47'])
  })

  it('runs bulk operations', () => {
    createTask('task-48')
    createTask('task-49')
    createTask('task-50')

    expect(bulkCompleteTasks(db, ['task-48', 'task-49'])).toBe(2)
    expect(bulkMoveTasks(db, ['task-48'], projectId)).toBe(1)
    expect(bulkArchiveTasks(db, ['task-50'])).toBe(1)
    expect(bulkDeleteTasks(db, ['task-49'])).toBe(1)
  })

  it('computes task stats and next positions', () => {
    createTask('task-51', { dueDate: YESTERDAY })
    createTask('task-52', { dueDate: TODAY })
    createTask('task-53', { dueDate: TOMORROW })
    createTask('task-54', { completedAt: '2026-01-10T10:00:00.000Z' })
    createTask('task-55', { archivedAt: '2026-01-10T10:00:00.000Z' })

    const stats = getTaskStats(db)
    expect(stats.total).toBe(4)
    expect(stats.completed).toBe(1)
    expect(stats.overdue).toBe(1)
    expect(stats.dueToday).toBe(1)
    expect(stats.dueThisWeek).toBe(2)

    createTask('task-56', { position: 3 })
    expect(getNextTaskPosition(db, projectId)).toBe(4)

    const parent = createTask('task-57', { position: 0 })
    createTask('task-58', { parentId: parent.id, position: 2 })
    expect(getNextTaskPosition(db, projectId, parent.id)).toBe(3)
  })
})
