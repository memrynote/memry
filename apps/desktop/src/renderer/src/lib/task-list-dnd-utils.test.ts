import { describe, expect, it } from 'vitest'

import {
  annotateFlatVirtualItems,
  annotateGroupedVirtualItems,
  annotateProjectStatusVirtualItems
} from './task-list-dnd-utils'
import type {
  GroupHeaderItem,
  ParentTaskItem,
  StatusHeaderItem,
  TaskItem,
  VirtualItem
} from './virtual-list-utils'
import type { Priority, Task } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

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
  name: 'Inbox',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createStatus({ id: 'p1-todo', type: 'todo', name: 'To Do', order: 0 }),
    createStatus({ id: 'p1-progress', type: 'in_progress', name: 'Doing', order: 1 }),
    createStatus({ id: 'p1-done', type: 'done', name: 'Done', order: 2 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Task',
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

describe('task-list-dnd-utils', () => {
  it('annotateFlatVirtualItems assigns a shared section id and section task ids', () => {
    const project = createProject()
    const items: VirtualItem[] = [
      {
        id: 'task-a',
        type: 'task',
        task: createTask({ id: 'a' }),
        project,
        sectionId: 'flat'
      } satisfies TaskItem,
      {
        id: 'parent-b',
        type: 'parent-task',
        task: createTask({ id: 'b', subtaskIds: ['sub-1'] }),
        project,
        subtasks: [createTask({ id: 'sub-1', parentId: 'b' })],
        sectionId: 'flat'
      } satisfies ParentTaskItem
    ]

    const result = annotateFlatVirtualItems(items, { sectionId: 'done' })

    expect((result[0] as TaskItem).sectionId).toBe('done')
    expect((result[1] as ParentTaskItem).sectionId).toBe('done')
    expect((result[0] as TaskItem).sectionTaskIds).toEqual(['a', 'b'])
    expect((result[1] as ParentTaskItem).sectionTaskIds).toEqual(['a', 'b'])
  })

  it('annotateGroupedVirtualItems adds mutable priority drop metadata to group headers and rows', () => {
    const project = createProject()
    const items: VirtualItem[] = [
      {
        id: 'group-header-high',
        type: 'group-header',
        groupKey: 'high',
        label: 'High',
        count: 2,
        sortField: 'priority'
      } satisfies GroupHeaderItem,
      {
        id: 'task-a',
        type: 'task',
        task: createTask({ id: 'a', priority: 'high' }),
        project,
        sectionId: 'high'
      } satisfies TaskItem,
      {
        id: 'task-b',
        type: 'task',
        task: createTask({ id: 'b', priority: 'high' }),
        project,
        sectionId: 'high'
      } satisfies TaskItem
    ]

    const result = annotateGroupedVirtualItems(items, {
      sortField: 'priority',
      projects: [project]
    })

    const header = result[0] as GroupHeaderItem
    const firstTask = result[1] as TaskItem

    expect(header.columnId).toBe('priority-high')
    expect(header.sectionTaskIds).toEqual(['a', 'b'])
    expect(firstTask.columnId).toBe('priority-high')
    expect(firstTask.sectionTaskIds).toEqual(['a', 'b'])
  })

  it('annotateGroupedVirtualItems keeps overdue due-date groups read-only while allowing mutable buckets', () => {
    const project = createProject()
    const items: VirtualItem[] = [
      {
        id: 'group-header-overdue',
        type: 'group-header',
        groupKey: 'overdue',
        label: 'Overdue',
        count: 1,
        sortField: 'dueDate'
      } satisfies GroupHeaderItem,
      {
        id: 'task-overdue',
        type: 'task',
        task: createTask({ id: 'overdue-task', dueDate: new Date('2026-01-10') }),
        project,
        sectionId: 'overdue'
      } satisfies TaskItem,
      {
        id: 'group-header-today',
        type: 'group-header',
        groupKey: 'today',
        label: 'Today',
        count: 1,
        sortField: 'dueDate'
      } satisfies GroupHeaderItem,
      {
        id: 'task-today',
        type: 'task',
        task: createTask({ id: 'today-task', dueDate: new Date('2026-01-15') }),
        project,
        sectionId: 'today'
      } satisfies TaskItem
    ]

    const result = annotateGroupedVirtualItems(items, {
      sortField: 'dueDate',
      projects: [project]
    })

    expect((result[0] as GroupHeaderItem).columnId).toBeUndefined()
    expect((result[1] as TaskItem).columnId).toBeUndefined()
    expect((result[2] as GroupHeaderItem).columnId).toBe('due-today')
    expect((result[3] as TaskItem).columnId).toBe('due-today')
  })

  it('annotateGroupedVirtualItems maps all-task status groups to canonical status targets', () => {
    const project = createProject()
    const items: VirtualItem[] = [
      {
        id: 'group-header-progress',
        type: 'group-header',
        groupKey: 'in_progress',
        label: 'In Progress',
        count: 1,
        sortField: 'status'
      } satisfies GroupHeaderItem,
      {
        id: 'task-progress',
        type: 'task',
        task: createTask({ id: 'progress-task', statusId: 'p1-progress' }),
        project,
        sectionId: 'in_progress'
      } satisfies TaskItem
    ]

    const result = annotateGroupedVirtualItems(items, {
      sortField: 'status',
      projects: [project]
    })

    expect((result[0] as GroupHeaderItem).columnId).toBe('in_progress')
    expect((result[1] as TaskItem).columnId).toBe('in_progress')
  })

  it('annotateProjectStatusVirtualItems restores exact project-status drop targets', () => {
    const project = createProject()
    const items: VirtualItem[] = [
      {
        id: 'status-header-p1-progress',
        type: 'status-header',
        status: project.statuses[1],
        count: 2
      } satisfies StatusHeaderItem,
      {
        id: 'task-a',
        type: 'task',
        task: createTask({ id: 'a', statusId: 'p1-progress' }),
        project,
        sectionId: 'p1-progress'
      } satisfies TaskItem,
      {
        id: 'task-b',
        type: 'task',
        task: createTask({ id: 'b', statusId: 'p1-progress' }),
        project,
        sectionId: 'p1-progress'
      } satisfies TaskItem
    ]

    const result = annotateProjectStatusVirtualItems(items)

    expect((result[0] as StatusHeaderItem).columnId).toBe('p1-progress')
    expect((result[0] as StatusHeaderItem).sectionTaskIds).toEqual(['a', 'b'])
    expect((result[1] as TaskItem).columnId).toBe('p1-progress')
    expect((result[1] as TaskItem).sectionTaskIds).toEqual(['a', 'b'])
  })
})
