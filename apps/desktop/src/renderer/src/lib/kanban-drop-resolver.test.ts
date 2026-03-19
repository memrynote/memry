import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import { resolveColumnDrop, dueBucketToDate } from './kanban-drop-resolver'

const createStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-todo',
  name: 'To Do',
  color: '#6b7280',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Project A',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createStatus({ id: 'p1-todo', name: 'To Do', type: 'todo', order: 0 }),
    createStatus({ id: 'p1-progress', name: 'In Progress', type: 'in_progress', order: 1 }),
    createStatus({ id: 'p1-done', name: 'Done', type: 'done', order: 2 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

describe('resolveColumnDrop', () => {
  const projectA = createProject({ id: 'proj-a' })
  const projectB = createProject({
    id: 'proj-b',
    statuses: [
      createStatus({ id: 'pb-todo', type: 'todo', order: 0 }),
      createStatus({ id: 'pb-done', type: 'done', order: 1 })
    ]
  })
  const projects = [projectA, projectB]

  describe('priority columns', () => {
    it.each(['urgent', 'high', 'medium', 'low', 'none'] as const)(
      'resolves priority-%s to priority result',
      (level) => {
        // #when
        const result = resolveColumnDrop(`priority-${level}`, projects)

        // #then
        expect(result).toEqual({ type: 'priority', priority: level })
      }
    )

    it('returns null for invalid priority level', () => {
      expect(resolveColumnDrop('priority-invalid', projects)).toBeNull()
    })
  })

  describe('due date columns', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 2, 17))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('resolves due-today to start of today', () => {
      const result = resolveColumnDrop('due-today', projects)
      expect(result).toMatchObject({ type: 'dueDate' })
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toEqual(new Date(2026, 2, 17))
      }
    })

    it('resolves due-tomorrow to start of tomorrow', () => {
      const result = resolveColumnDrop('due-tomorrow', projects)
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toEqual(new Date(2026, 2, 18))
      }
    })

    it('resolves due-upcoming to 3 days from now', () => {
      const result = resolveColumnDrop('due-upcoming', projects)
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toEqual(new Date(2026, 2, 20))
      }
    })

    it('resolves due-later to 14 days from now', () => {
      const result = resolveColumnDrop('due-later', projects)
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toEqual(new Date(2026, 2, 31))
      }
    })

    it('resolves due-overdue to null (clear due date)', () => {
      const result = resolveColumnDrop('due-overdue', projects)
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toBeNull()
      }
    })

    it('resolves due-noDueDate to null', () => {
      const result = resolveColumnDrop('due-noDueDate', projects)
      if (result?.type === 'dueDate') {
        expect(result.dueDate).toBeNull()
      }
    })
  })

  describe('project columns', () => {
    it('resolves project-{id} to project result', () => {
      const result = resolveColumnDrop('project-proj-a', projects)
      expect(result).toEqual({ type: 'project', projectId: 'proj-a' })
    })
  })

  describe('canonical status columns', () => {
    it.each(['todo', 'in_progress', 'done'] as const)(
      'resolves %s to canonical status',
      (status) => {
        const result = resolveColumnDrop(status, projects)
        expect(result).toEqual({ type: 'canonicalStatus', statusType: status })
      }
    )
  })

  describe('project-specific status columns', () => {
    it('resolves real status ID to projectStatus with owning project', () => {
      const result = resolveColumnDrop('p1-progress', projects)
      expect(result).toEqual({
        type: 'projectStatus',
        columnId: 'p1-progress',
        project: projectA
      })
    })

    it('finds correct project for ambiguous status ID', () => {
      const result = resolveColumnDrop('pb-done', projects)
      expect(result).toEqual({
        type: 'projectStatus',
        columnId: 'pb-done',
        project: projectB
      })
    })
  })

  describe('unknown columns', () => {
    it('returns null for unrecognized column ID', () => {
      expect(resolveColumnDrop('unknown-column-id', projects)).toBeNull()
    })
  })
})

describe('dueBucketToDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 17))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns label alongside date for each bucket', () => {
    expect(dueBucketToDate('today').label).toBe('Today')
    expect(dueBucketToDate('tomorrow').label).toBe('Tomorrow')
    expect(dueBucketToDate('upcoming').label).toBe('This Week')
    expect(dueBucketToDate('later').label).toBe('Later')
    expect(dueBucketToDate('overdue').label).toBe('No Due Date')
    expect(dueBucketToDate('noDueDate').label).toBe('No Due Date')
  })
})
