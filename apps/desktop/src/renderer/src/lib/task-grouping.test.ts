import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import {
  groupByDueDate,
  groupByPriority,
  groupByProject,
  groupByCreatedDate,
  groupByStatus,
  groupTasksForSort
} from './task-grouping'

// ============================================================================
// MOCK FACTORIES
// ============================================================================

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).substring(2, 9)}`,
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'status-todo',
  priority: 'none' as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-todo',
  name: 'Todo',
  color: '#gray',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [createMockStatus()],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

// ============================================================================
// TESTS
// ============================================================================

describe('task-grouping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================================================
  // groupByDueDate
  // ==========================================================================

  describe('groupByDueDate', () => {
    it('should return empty array for empty tasks', () => {
      // #given
      const tasks: Task[] = []

      // #when
      const result = groupByDueDate(tasks)

      // #then
      expect(result).toEqual([])
    })

    it('should bucket tasks into correct due date groups', () => {
      // #given
      const overdue = createMockTask({ id: 'overdue', dueDate: new Date(2026, 0, 10) })
      const today = createMockTask({ id: 'today', dueDate: new Date(2026, 0, 15) })
      const tomorrow = createMockTask({ id: 'tomorrow', dueDate: new Date(2026, 0, 16) })
      const upcoming = createMockTask({ id: 'upcoming', dueDate: new Date(2026, 0, 20) })
      const later = createMockTask({ id: 'later', dueDate: new Date(2026, 1, 15) })
      const noDue = createMockTask({ id: 'no-due', dueDate: null })

      // #when
      const result = groupByDueDate([overdue, today, tomorrow, upcoming, later, noDue])

      // #then
      expect(result).toHaveLength(6)
      expect(result[0]).toMatchObject({ key: 'overdue', label: 'Overdue', variant: 'overdue' })
      expect(result[0].tasks).toHaveLength(1)
      expect(result[1]).toMatchObject({ key: 'today', label: 'Today' })
      expect(result[2]).toMatchObject({ key: 'tomorrow', label: 'Tomorrow' })
      expect(result[3]).toMatchObject({ key: 'upcoming', label: 'This Week' })
      expect(result[4]).toMatchObject({ key: 'later', label: 'Later' })
      expect(result[5]).toMatchObject({ key: 'noDueDate', label: 'No Due Date' })
    })

    it('should omit empty groups', () => {
      // #given
      const today = createMockTask({ dueDate: new Date(2026, 0, 15) })

      // #when
      const result = groupByDueDate([today])

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('today')
    })

    it('should set overdue variant and color', () => {
      // #given
      const overdue = createMockTask({ dueDate: new Date(2026, 0, 1) })

      // #when
      const result = groupByDueDate([overdue])

      // #then
      expect(result[0].variant).toBe('overdue')
      expect(result[0].color).toBe('#ef4444')
    })
  })

  // ==========================================================================
  // groupByPriority
  // ==========================================================================

  describe('groupByPriority', () => {
    it('should return empty array for empty tasks', () => {
      expect(groupByPriority([])).toEqual([])
    })

    it('should group tasks by priority in correct order', () => {
      // #given
      const urgent = createMockTask({ id: 'u', priority: 'urgent' })
      const high = createMockTask({ id: 'h', priority: 'high' })
      const medium = createMockTask({ id: 'm', priority: 'medium' })
      const low = createMockTask({ id: 'l', priority: 'low' })
      const none = createMockTask({ id: 'n', priority: 'none' })

      // #when
      const result = groupByPriority([none, low, urgent, high, medium])

      // #then
      expect(result).toHaveLength(5)
      expect(result.map((g) => g.key)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
      expect(result[0].label).toBe('Urgent')
      expect(result[4].label).toBe('No Priority')
    })

    it('should include priority colors from config', () => {
      // #given
      const urgent = createMockTask({ priority: 'urgent' })

      // #when
      const result = groupByPriority([urgent])

      // #then
      expect(result[0].color).toBe('var(--task-priority-urgent)')
    })

    it('should handle tasks with undefined priority as none', () => {
      // #given
      const task = createMockTask({ priority: undefined as unknown as Priority })

      // #when
      const result = groupByPriority([task])

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('none')
    })
  })

  // ==========================================================================
  // groupByProject
  // ==========================================================================

  describe('groupByProject', () => {
    it('should return empty array for empty tasks', () => {
      expect(groupByProject([], [createMockProject()])).toEqual([])
    })

    it('should group tasks by project with color', () => {
      // #given
      const project1 = createMockProject({ id: 'p1', name: 'Alpha', color: '#ff0000' })
      const project2 = createMockProject({ id: 'p2', name: 'Beta', color: '#00ff00' })
      const t1 = createMockTask({ projectId: 'p1' })
      const t2 = createMockTask({ projectId: 'p2' })
      const t3 = createMockTask({ projectId: 'p1' })

      // #when
      const result = groupByProject([t1, t2, t3], [project1, project2])

      // #then
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ key: 'p1', label: 'Alpha', color: '#ff0000' })
      expect(result[0].tasks).toHaveLength(2)
      expect(result[1]).toMatchObject({ key: 'p2', label: 'Beta', color: '#00ff00' })
    })

    it('should sort groups alphabetically by project name', () => {
      // #given
      const projectZ = createMockProject({ id: 'pz', name: 'Zebra' })
      const projectA = createMockProject({ id: 'pa', name: 'Apple' })
      const t1 = createMockTask({ projectId: 'pz' })
      const t2 = createMockTask({ projectId: 'pa' })

      // #when
      const result = groupByProject([t1, t2], [projectZ, projectA])

      // #then
      expect(result[0].label).toBe('Apple')
      expect(result[1].label).toBe('Zebra')
    })

    it('should place tasks without matching project in No Project group', () => {
      // #given
      const task = createMockTask({ projectId: 'nonexistent' })

      // #when
      const result = groupByProject([task], [createMockProject()])

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ key: 'no-project', label: 'No Project' })
    })
  })

  // ==========================================================================
  // groupByCreatedDate
  // ==========================================================================

  describe('groupByCreatedDate', () => {
    it('should return empty array for empty tasks', () => {
      expect(groupByCreatedDate([])).toEqual([])
    })

    it('should bucket tasks by creation date', () => {
      // #given — system time is 2026-01-15
      const today = createMockTask({ createdAt: new Date(2026, 0, 15) })
      const yesterday = createMockTask({ createdAt: new Date(2026, 0, 14) })
      const thisWeek = createMockTask({ createdAt: new Date(2026, 0, 10) })
      const earlier = createMockTask({ createdAt: new Date(2025, 11, 1) })

      // #when
      const result = groupByCreatedDate([today, yesterday, thisWeek, earlier])

      // #then
      expect(result).toHaveLength(4)
      expect(result.map((g) => g.key)).toEqual(['today', 'yesterday', 'thisWeek', 'earlier'])
    })

    it('should omit empty creation date groups', () => {
      // #given
      const today = createMockTask({ createdAt: new Date(2026, 0, 15) })

      // #when
      const result = groupByCreatedDate([today])

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('today')
    })
  })

  // ==========================================================================
  // groupByStatus
  // ==========================================================================

  describe('groupByStatus', () => {
    it('should return empty array for empty tasks', () => {
      expect(groupByStatus([], [createMockProject()])).toEqual([])
    })

    it('should group tasks by non-done statuses only', () => {
      // #given
      const project = createMockProject({
        id: 'p1',
        statuses: [
          createMockStatus({ id: 's-todo', name: 'Todo', type: 'todo', color: '#gray', order: 0 }),
          createMockStatus({
            id: 's-doing',
            name: 'In Progress',
            type: 'in_progress',
            color: '#blue',
            order: 1
          }),
          createMockStatus({ id: 's-done', name: 'Done', type: 'done', color: '#green', order: 2 })
        ]
      })
      const todoTask = createMockTask({ id: 't1', statusId: 's-todo', projectId: 'p1' })
      const doingTask = createMockTask({ id: 't2', statusId: 's-doing', projectId: 'p1' })
      const doneTask = createMockTask({ id: 't3', statusId: 's-done', projectId: 'p1' })

      // #when
      const result = groupByStatus([todoTask, doingTask, doneTask], [project])

      // #then — done group excluded
      expect(result).toHaveLength(2)
      expect(result.map((g) => g.key)).toEqual(['todo', 'in_progress'])
      expect(result.map((g) => g.label)).toEqual(['To Do', 'In Progress'])
    })

    it('should not place done tasks in uncategorized', () => {
      // #given
      const project = createMockProject({
        id: 'p1',
        statuses: [
          createMockStatus({ id: 's-todo', name: 'Todo', type: 'todo', color: '#gray', order: 0 }),
          createMockStatus({ id: 's-done', name: 'Done', type: 'done', color: '#green', order: 1 })
        ]
      })
      const doneTask = createMockTask({ id: 't1', statusId: 's-done', projectId: 'p1' })

      // #when
      const result = groupByStatus([doneTask], [project])

      // #then — no groups at all, done task silently excluded
      expect(result).toHaveLength(0)
    })

    it('should place tasks with unknown status in uncategorized', () => {
      // #given
      const project = createMockProject({
        id: 'p1',
        statuses: [
          createMockStatus({ id: 's-todo', name: 'Todo', type: 'todo', color: '#gray', order: 0 })
        ]
      })
      const unknownTask = createMockTask({ id: 't1', statusId: 'nonexistent', projectId: 'p1' })

      // #when
      const result = groupByStatus([unknownTask], [project])

      // #then
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ key: 'uncategorized', label: 'Uncategorized' })
    })

    it('should sort groups by status type order then by status order', () => {
      // #given
      const project = createMockProject({
        id: 'p1',
        statuses: [
          createMockStatus({
            id: 's-doing',
            name: 'Doing',
            type: 'in_progress',
            color: '#blue',
            order: 1
          }),
          createMockStatus({ id: 's-todo', name: 'Todo', type: 'todo', color: '#gray', order: 0 })
        ]
      })
      const doingTask = createMockTask({ id: 't1', statusId: 's-doing', projectId: 'p1' })
      const todoTask = createMockTask({ id: 't2', statusId: 's-todo', projectId: 'p1' })

      // #when
      const result = groupByStatus([doingTask, todoTask], [project])

      // #then — todo before in_progress
      expect(result[0].key).toBe('todo')
      expect(result[1].key).toBe('in_progress')
    })
  })

  // ==========================================================================
  // groupTasksForSort (dispatcher)
  // ==========================================================================

  describe('groupTasksForSort', () => {
    const projects = [createMockProject()]

    it('should return empty array for title sort', () => {
      const task = createMockTask()
      expect(groupTasksForSort([task], 'title', 'asc', projects)).toEqual([])
    })

    it('should return empty array for completedAt sort', () => {
      const task = createMockTask()
      expect(groupTasksForSort([task], 'completedAt', 'asc', projects)).toEqual([])
    })

    it('should dispatch to dueDate grouper', () => {
      // #given
      const task = createMockTask({ dueDate: new Date(2026, 0, 15) })

      // #when
      const result = groupTasksForSort([task], 'dueDate', 'asc', projects)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('today')
    })

    it('should dispatch to priority grouper', () => {
      // #given
      const task = createMockTask({ priority: 'high' })

      // #when
      const result = groupTasksForSort([task], 'priority', 'asc', projects)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('high')
    })

    it('should dispatch to project grouper', () => {
      // #given
      const task = createMockTask({ projectId: 'project-1' })

      // #when
      const result = groupTasksForSort([task], 'project', 'asc', projects)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe('Test Project')
    })

    it('should dispatch to createdAt grouper', () => {
      // #given
      const task = createMockTask({ createdAt: new Date(2026, 0, 15) })

      // #when
      const result = groupTasksForSort([task], 'createdAt', 'asc', projects)

      // #then
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('today')
    })

    it('should reverse group order for desc direction', () => {
      // #given
      const urgent = createMockTask({ priority: 'urgent' })
      const low = createMockTask({ priority: 'low' })

      // #when
      const asc = groupTasksForSort([urgent, low], 'priority', 'asc', projects)
      const desc = groupTasksForSort([urgent, low], 'priority', 'desc', projects)

      // #then
      expect(asc[0].key).toBe('urgent')
      expect(asc[1].key).toBe('low')
      expect(desc[0].key).toBe('low')
      expect(desc[1].key).toBe('urgent')
    })
  })
})
