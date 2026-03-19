import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import { buildColumnConfig } from './kanban-columns'
import { resolveColumnDrop } from '@/lib/kanban-drop-resolver'

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

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).substring(2, 9)}`,
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'p1-todo',
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

describe('buildColumnConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 17))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const projectA = createProject({
    id: 'project-a',
    name: 'Project A',
    statuses: [
      createStatus({ id: 'pa-backlog', name: 'Backlog', type: 'todo', order: 0 }),
      createStatus({ id: 'pa-progress', name: 'In Progress', type: 'in_progress', order: 1 }),
      createStatus({ id: 'pa-review', name: 'In Review', type: 'in_progress', order: 2 }),
      createStatus({ id: 'pa-done', name: 'Done', type: 'done', order: 3 })
    ]
  })

  const projectB = createProject({
    id: 'project-b',
    name: 'Project B',
    statuses: [
      createStatus({ id: 'pb-todo', name: 'To Do', type: 'todo', order: 0 }),
      createStatus({ id: 'pb-done', name: 'Complete', type: 'done', order: 1 })
    ]
  })

  const projects = [projectA, projectB]

  describe('status sort with selected project', () => {
    it('shows only the selected project statuses as columns', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'status')

      // #then — only 4 columns from project A, not 6 from both projects
      expect(config.columns).toHaveLength(4)
      expect(config.columns.map((c) => c.title)).toEqual([
        'Backlog',
        'In Progress',
        'In Review',
        'Done'
      ])
    })

    it('shows project B statuses when project B is selected', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-b', statusId: 'pb-todo' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', 'project-b', 'status')

      // #then — only 2 columns from project B
      expect(config.columns).toHaveLength(2)
      expect(config.columns.map((c) => c.title)).toEqual(['To Do', 'Complete'])
    })

    it('shows empty columns for statuses with no tasks', () => {
      // #given — task only in Backlog, but all 4 columns should appear
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'status')

      // #then
      expect(config.columns).toHaveLength(4)
      expect(config.tasksByColumn.get('pa-progress')).toEqual([])
      expect(config.tasksByColumn.get('pa-review')).toEqual([])
      expect(config.tasksByColumn.get('pa-done')).toEqual([])
      expect(config.tasksByColumn.get('pa-backlog')).toHaveLength(1)
    })

    it('does not include tasks from other projects', () => {
      // #given
      const tasks = [
        createTask({ id: 't1', projectId: 'project-a', statusId: 'pa-backlog' }),
        createTask({ id: 't2', projectId: 'project-b', statusId: 'pb-todo' })
      ]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'status')

      // #then — only task t1 appears
      const allTasks = Array.from(config.tasksByColumn.values()).flat()
      expect(allTasks).toHaveLength(1)
      expect(allTasks[0].id).toBe('t1')
    })
  })

  describe('status sort without selected project', () => {
    it('falls back to canonical 3 columns when no project selected', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'status')

      // #then
      expect(config.mode).toBe('canonical')
      expect(config.columns).toHaveLength(3)
      expect(config.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    })

    it('aggregates tasks by statusType across all projects', () => {
      // #given
      const tasks = [
        createTask({ projectId: 'project-a', statusId: 'pa-backlog' }),
        createTask({ projectId: 'project-b', statusId: 'pb-todo' }),
        createTask({ projectId: 'project-a', statusId: 'pa-done' })
      ]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'status')

      // #then
      expect(config.tasksByColumn.get('todo')).toHaveLength(2)
      expect(config.tasksByColumn.get('done')).toHaveLength(1)
      expect(config.tasksByColumn.get('in_progress')).toHaveLength(0)
    })
  })

  describe('default mode (no status sort)', () => {
    it('shows selected project statuses when project is selected', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'dueDate')

      // #then — default mode uses project columns, not dueDate columns,
      // because dueDate sort should produce dueDate columns
      // Actually, dueDate sort always produces dueDate columns regardless of project.
      // Let's test with 'createdAt' sort which falls through to default.
      const config2 = buildColumnConfig(tasks, projects, 'view', 'project-a', 'createdAt')

      expect(config2.mode).toBe('project')
      expect(config2.columns).toHaveLength(4)
      expect(config2.columns.map((c) => c.title)).toEqual([
        'Backlog',
        'In Progress',
        'In Review',
        'Done'
      ])
    })

    it('shows canonical 3 columns when no project selected and no special sort', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'createdAt')

      // #then
      expect(config.mode).toBe('canonical')
      expect(config.columns).toHaveLength(3)
    })
  })

  describe('all columns always visible', () => {
    it('shows all priority columns even when no tasks match', () => {
      // #given
      const tasks = [createTask({ priority: 'high' })]

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'priority')

      // #then — all 5 priority columns present
      expect(config.columns).toHaveLength(5)
    })

    it('shows all due date columns even when no tasks match', () => {
      // #given — no tasks at all
      const tasks: Task[] = []

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'dueDate')

      // #then — all 6 date columns present
      expect(config.columns).toHaveLength(6)
    })

    it('shows all project columns even when no tasks match', () => {
      // #given — no tasks
      const tasks: Task[] = []

      // #when
      const config = buildColumnConfig(tasks, projects, 'view', null, 'project')

      // #then — both projects show
      expect(config.columns).toHaveLength(2)
    })
  })

  describe('drag-to-done regression (completed tasks in kanban)', () => {
    it('places completed task in done column when task has done statusId', () => {
      // #given — task dropped to Done column gets statusId + completedAt set
      const completedTask = createTask({
        id: 'dropped-task',
        projectId: 'project-a',
        statusId: 'pa-done',
        completedAt: new Date()
      })
      const tasks = [
        createTask({ id: 'active-task', projectId: 'project-a', statusId: 'pa-backlog' }),
        completedTask
      ]

      // #when — buildColumnConfig receives both active and completed tasks
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'status')

      // #then — completed task appears in done column
      const doneTasks = config.tasksByColumn.get('pa-done') ?? []
      expect(doneTasks).toHaveLength(1)
      expect(doneTasks[0].id).toBe('dropped-task')
    })

    it('places completed task in canonical done column when no project selected', () => {
      // #given — completed task with done status type
      const tasks = [
        createTask({ id: 'active', projectId: 'project-a', statusId: 'pa-backlog' }),
        createTask({
          id: 'done-task',
          projectId: 'project-a',
          statusId: 'pa-done',
          completedAt: new Date()
        })
      ]

      // #when — canonical mode (no project selected)
      const config = buildColumnConfig(tasks, projects, 'view', null, 'status')

      // #then — completed task in canonical 'done' column
      const doneTasks = config.tasksByColumn.get('done') ?? []
      expect(doneTasks).toHaveLength(1)
      expect(doneTasks[0].id).toBe('done-task')
    })
  })

  describe('column ID patterns match resolver expectations', () => {
    it('priority column IDs are resolvable by drop resolver', () => {
      // #given
      const tasks = [createTask({ priority: 'high' })]
      const config = buildColumnConfig(tasks, projects, 'view', null, 'priority')

      // #then — every generated column ID resolves to a priority result
      for (const col of config.columns) {
        const result = resolveColumnDrop(col.id, projects)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('priority')
      }
    })

    it('due date column IDs are resolvable by drop resolver', () => {
      // #given
      const config = buildColumnConfig([], projects, 'view', null, 'dueDate')

      // #then
      for (const col of config.columns) {
        const result = resolveColumnDrop(col.id, projects)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('dueDate')
      }
    })

    it('project column IDs are resolvable by drop resolver', () => {
      // #given
      const config = buildColumnConfig([], projects, 'view', null, 'project')

      // #then
      for (const col of config.columns) {
        const result = resolveColumnDrop(col.id, projects)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('project')
      }
    })

    it('canonical status column IDs are resolvable by drop resolver', () => {
      // #given
      const config = buildColumnConfig([], projects, 'view', null, 'status')

      // #then — canonical columns (todo/in_progress/done)
      expect(config.mode).toBe('canonical')
      for (const col of config.columns) {
        const result = resolveColumnDrop(col.id, projects)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('canonicalStatus')
      }
    })

    it('project-scoped status column IDs are resolvable by drop resolver', () => {
      // #given
      const tasks = [createTask({ projectId: 'project-a', statusId: 'pa-backlog' })]
      const config = buildColumnConfig(tasks, projects, 'view', 'project-a', 'status')

      // #then — project status columns resolve to projectStatus
      for (const col of config.columns) {
        const result = resolveColumnDrop(col.id, projects)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('projectStatus')
      }
    })
  })
})
