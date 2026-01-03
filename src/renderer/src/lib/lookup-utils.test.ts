import { describe, it, expect } from 'vitest'
import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'
import {
  createProjectMap,
  createCompletionStatusMap,
  isTaskCompletedFast,
  getProjectFromMap,
  createLookupContext,
  getTaskContext,
  type LookupContext
} from './lookup-utils'

// Mock factories
const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-1',
  name: 'Todo',
  type: 'todo',
  color: '#gray',
  order: 0,
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createMockStatus({ id: 'status-todo', name: 'Todo', type: 'todo', order: 0 }),
    createMockStatus({ id: 'status-progress', name: 'In Progress', type: 'in_progress', order: 1 }),
    createMockStatus({ id: 'status-done', name: 'Done', type: 'done', order: 2 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-01-01'),
  taskCount: 0,
  ...overrides
})

const createMockTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    title: 'Test Task',
    description: '',
    projectId: 'project-1',
    statusId: 'status-todo',
    priority: 'medium',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId: null,
    subtaskIds: [],
    createdAt: new Date('2026-01-01'),
    completedAt: null,
    archivedAt: null,
    ...overrides
  }) as Task

describe('lookup-utils', () => {
  describe('createProjectMap', () => {
    it('should create empty map for empty array', () => {
      const map = createProjectMap([])
      expect(map.size).toBe(0)
    })

    it('should create map with single project', () => {
      const project = createMockProject({ id: 'proj-1', name: 'Project 1' })
      const map = createProjectMap([project])

      expect(map.size).toBe(1)
      expect(map.get('proj-1')).toBe(project)
    })

    it('should create map with multiple projects', () => {
      const projects = [
        createMockProject({ id: 'proj-1', name: 'Project 1' }),
        createMockProject({ id: 'proj-2', name: 'Project 2' }),
        createMockProject({ id: 'proj-3', name: 'Project 3' })
      ]
      const map = createProjectMap(projects)

      expect(map.size).toBe(3)
      expect(map.get('proj-1')?.name).toBe('Project 1')
      expect(map.get('proj-2')?.name).toBe('Project 2')
      expect(map.get('proj-3')?.name).toBe('Project 3')
    })

    it('should return undefined for non-existent project', () => {
      const project = createMockProject({ id: 'proj-1' })
      const map = createProjectMap([project])

      expect(map.get('non-existent')).toBeUndefined()
    })
  })

  describe('createCompletionStatusMap', () => {
    it('should create empty map for empty array', () => {
      const map = createCompletionStatusMap([])
      expect(map.size).toBe(0)
    })

    it('should create nested map with status completion info', () => {
      const project = createMockProject({ id: 'proj-1' })
      const map = createCompletionStatusMap([project])

      expect(map.size).toBe(1)
      const statusMap = map.get('proj-1')
      expect(statusMap).toBeDefined()
      expect(statusMap?.get('status-todo')).toBe(false)
      expect(statusMap?.get('status-progress')).toBe(false)
      expect(statusMap?.get('status-done')).toBe(true)
    })

    it('should handle multiple projects', () => {
      const projects = [
        createMockProject({ id: 'proj-1' }),
        createMockProject({
          id: 'proj-2',
          statuses: [createMockStatus({ id: 'custom-done', type: 'done' })]
        })
      ]
      const map = createCompletionStatusMap(projects)

      expect(map.size).toBe(2)
      expect(map.get('proj-1')?.get('status-done')).toBe(true)
      expect(map.get('proj-2')?.get('custom-done')).toBe(true)
    })
  })

  describe('isTaskCompletedFast', () => {
    const project = createMockProject({ id: 'proj-1' })
    const completionMap = createCompletionStatusMap([project])

    it('should return false for task in todo status', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'status-todo' })
      expect(isTaskCompletedFast(task, completionMap)).toBe(false)
    })

    it('should return false for task in progress status', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'status-progress' })
      expect(isTaskCompletedFast(task, completionMap)).toBe(false)
    })

    it('should return true for task in done status', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'status-done' })
      expect(isTaskCompletedFast(task, completionMap)).toBe(true)
    })

    it('should return false for non-existent project', () => {
      const task = createMockTask({ projectId: 'non-existent', statusId: 'status-done' })
      expect(isTaskCompletedFast(task, completionMap)).toBe(false)
    })

    it('should return false for non-existent status', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'non-existent' })
      expect(isTaskCompletedFast(task, completionMap)).toBe(false)
    })
  })

  describe('getProjectFromMap', () => {
    it('should return project from map', () => {
      const project = createMockProject({ id: 'proj-1', name: 'Test' })
      const map = createProjectMap([project])

      expect(getProjectFromMap('proj-1', map)).toBe(project)
    })

    it('should return undefined for non-existent project', () => {
      const project = createMockProject({ id: 'proj-1' })
      const map = createProjectMap([project])

      expect(getProjectFromMap('non-existent', map)).toBeUndefined()
    })

    it('should return undefined for empty map', () => {
      const map = createProjectMap([])
      expect(getProjectFromMap('any-id', map)).toBeUndefined()
    })
  })

  describe('createLookupContext', () => {
    it('should create context with both maps', () => {
      const projects = [createMockProject({ id: 'proj-1' })]
      const context = createLookupContext(projects)

      expect(context.projectMap).toBeDefined()
      expect(context.completionMap).toBeDefined()
      expect(context.projectMap.size).toBe(1)
      expect(context.completionMap.size).toBe(1)
    })

    it('should create empty context for empty projects', () => {
      const context = createLookupContext([])

      expect(context.projectMap.size).toBe(0)
      expect(context.completionMap.size).toBe(0)
    })
  })

  describe('getTaskContext', () => {
    const projects = [createMockProject({ id: 'proj-1' })]
    const lookupContext = createLookupContext(projects)

    it('should return project and completion status for valid task', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'status-todo' })
      const result = getTaskContext(task, lookupContext)

      expect(result.project).toBeDefined()
      expect(result.project?.id).toBe('proj-1')
      expect(result.isCompleted).toBe(false)
    })

    it('should return isCompleted true for done status', () => {
      const task = createMockTask({ projectId: 'proj-1', statusId: 'status-done' })
      const result = getTaskContext(task, lookupContext)

      expect(result.isCompleted).toBe(true)
    })

    it('should return undefined project for non-existent project', () => {
      const task = createMockTask({ projectId: 'non-existent', statusId: 'status-todo' })
      const result = getTaskContext(task, lookupContext)

      expect(result.project).toBeUndefined()
      expect(result.isCompleted).toBe(false)
    })

    it('should provide O(1) lookup performance', () => {
      // Create many projects to test performance
      const manyProjects = Array.from({ length: 1000 }, (_, i) =>
        createMockProject({ id: `proj-${i}` })
      )
      const bigContext = createLookupContext(manyProjects)

      const task = createMockTask({ projectId: 'proj-500', statusId: 'status-done' })

      // Should be instant (O(1)) not O(n)
      const start = performance.now()
      for (let i = 0; i < 10000; i++) {
        getTaskContext(task, bigContext)
      }
      const elapsed = performance.now() - start

      // Should complete very fast (< 50ms for 10000 lookups)
      expect(elapsed).toBeLessThan(50)
    })
  })
})
