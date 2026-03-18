import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { DragEndEvent } from '@dnd-kit/core'

import { useDragHandlers } from './use-drag-handlers'
import type { DragState } from '@/contexts/drag-context'
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
  name: 'Project 1',
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

const createDragEvent = (overrides: Record<string, unknown>): DragEndEvent =>
  ({
    active: {
      id: 'task-1',
      data: { current: {} }
    },
    over: {
      id: 'task-2',
      data: { current: {} }
    },
    ...overrides
  }) as unknown as DragEndEvent

const createDragState = (overrides: Partial<DragState> = {}): DragState => ({
  isDragging: true,
  activeId: 'task-1',
  activeIds: ['task-1'],
  sourceType: 'list',
  sourceContainerId: 'urgent',
  overId: 'task-2',
  overType: 'task',
  overSectionId: 'urgent',
  overColumnId: null,
  overlayWidth: null,
  overlayRowVariant: null,
  overlayShowProjectBadge: false,
  overlayParentProgress: null,
  overlayParentExpanded: false,
  overTaskEdge: null,
  sectionDropPosition: null,
  draggedTasks: [],
  lastDroppedId: null,
  ...overrides
})

describe('useDragHandlers', () => {
  it('reorders within a section using the full section task order, not only active/over ids', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', priority: 'high' }),
      createTask({ id: 'task-2', priority: 'high' }),
      createTask({ id: 'task-3', priority: 'high' })
    ]
    const onUpdateTask = vi.fn()
    const onDeleteTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask,
        onReorder
      })
    )

    const event = createDragEvent({
      active: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'high',
            sectionTaskIds: ['task-1', 'task-2', 'task-3'],
            task: tasks[1]
          }
        }
      },
      over: {
        id: 'task-1',
        data: {
          current: {
            type: 'task',
            sectionId: 'high',
            sectionTaskIds: ['task-1', 'task-2', 'task-3'],
            task: tasks[0]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(
        event,
        createDragState({
          activeId: 'task-2',
          activeIds: ['task-2'],
          sourceContainerId: 'high',
          overSectionId: 'high',
          overTaskEdge: 'before'
        })
      )
    })

    expect(onReorder).toHaveBeenCalledWith({ high: ['task-2', 'task-1', 'task-3'] })
  })

  it('handles task-over-task priority drops by the explicit list column id', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', priority: 'urgent' }),
      createTask({ id: 'task-2', priority: 'high' })
    ]
    const onUpdateTask = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder: vi.fn()
      })
    )

    const event = createDragEvent({
      over: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'high',
            sectionTaskIds: ['task-2'],
            columnId: 'priority-high',
            task: tasks[1]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(event, createDragState({ sourceContainerId: 'urgent' }))
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
  })

  it('handles task-over-task no-due-date drops through the explicit list column id', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', dueDate: new Date('2026-01-18') }),
      createTask({ id: 'task-2', dueDate: null })
    ]
    const onUpdateTask = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder: vi.fn()
      })
    )

    const event = createDragEvent({
      over: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'noDueDate',
            sectionTaskIds: ['task-2'],
            columnId: 'due-noDueDate',
            task: tasks[1]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(event, createDragState({ sourceContainerId: 'today' }))
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: null })
  })

  it('handles task-over-task project moves by the explicit list column id', () => {
    const projectOne = createProject()
    const projectTwo = createProject({
      id: 'project-2',
      name: 'Project 2',
      statuses: [
        createStatus({ id: 'p2-todo', type: 'todo', name: 'To Do', order: 0 }),
        createStatus({ id: 'p2-progress', type: 'in_progress', name: 'Doing', order: 1 }),
        createStatus({ id: 'p2-done', type: 'done', name: 'Done', order: 2 })
      ]
    })
    const tasks = [
      createTask({ id: 'task-1', projectId: 'project-1', statusId: 'p1-todo' }),
      createTask({ id: 'task-2', projectId: 'project-2', statusId: 'p2-todo' })
    ]
    const onUpdateTask = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [projectOne, projectTwo],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder: vi.fn()
      })
    )

    const event = createDragEvent({
      over: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'project-2',
            sectionTaskIds: ['task-2'],
            columnId: 'project-project-2',
            task: tasks[1]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(event, createDragState({ sourceContainerId: 'project-1' }))
    })

    expect(onUpdateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ projectId: 'project-2', statusId: 'p2-todo' })
    )
  })

  it('handles task-over-task all-task status moves by canonical status type', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', statusId: 'p1-todo' }),
      createTask({ id: 'task-2', statusId: 'p1-progress' })
    ]
    const onUpdateTask = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder: vi.fn()
      })
    )

    const event = createDragEvent({
      over: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'p1-progress',
            sectionTaskIds: ['task-2'],
            columnId: 'in_progress',
            task: tasks[1]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(event, createDragState({ sourceContainerId: 'p1-todo' }))
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { statusId: 'p1-progress' })
  })

  it('orders a cross-section priority drop at the hovered row edge', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', priority: 'medium' }),
      createTask({ id: 'task-2', priority: 'high' }),
      createTask({ id: 'task-3', priority: 'high' })
    ]
    const onUpdateTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder,
        getOrder: vi.fn()
      })
    )

    const event = createDragEvent({
      active: {
        id: 'task-1',
        data: {
          current: {
            type: 'task',
            sectionId: 'medium',
            sectionTaskIds: ['task-1'],
            task: tasks[0]
          }
        }
      },
      over: {
        id: 'task-3',
        data: {
          current: {
            type: 'task',
            sectionId: 'high',
            sectionTaskIds: ['task-2', 'task-3'],
            columnId: 'priority-high',
            task: tasks[2]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(
        event,
        createDragState({
          sourceContainerId: 'medium',
          overSectionId: 'high',
          overColumnId: 'priority-high',
          overTaskEdge: 'before'
        })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
    expect(onReorder).toHaveBeenCalledWith({
      medium: [],
      high: ['task-2', 'task-1', 'task-3']
    })
  })

  it('inserts at the top when dropping on a target section header', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', priority: 'medium' }),
      createTask({ id: 'task-2', priority: 'high' }),
      createTask({ id: 'task-3', priority: 'high' })
    ]
    const onUpdateTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder,
        getOrder: vi.fn()
      })
    )

    const event = createDragEvent({
      active: {
        id: 'task-1',
        data: {
          current: {
            type: 'task',
            sectionId: 'medium',
            sectionTaskIds: ['task-1'],
            task: tasks[0]
          }
        }
      },
      over: {
        id: 'group-header-high',
        data: {
          current: {
            type: 'column',
            sectionId: 'high',
            sectionTaskIds: ['task-2', 'task-3'],
            columnId: 'priority-high',
            sectionDropPosition: 'start'
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(
        event,
        createDragState({
          sourceContainerId: 'medium',
          overId: 'group-header-high',
          overType: 'column',
          overSectionId: 'high',
          overColumnId: 'priority-high',
          sectionDropPosition: 'start'
        })
      )
    })

    expect(onReorder).toHaveBeenCalledWith({
      medium: [],
      high: ['task-1', 'task-2', 'task-3']
    })
  })

  it('restores task property and section orders when undoing a cross-section ordered move', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', priority: 'medium' }),
      createTask({ id: 'task-2', priority: 'high' }),
      createTask({ id: 'task-3', priority: 'high' })
    ]
    const onUpdateTask = vi.fn()
    const onReorder = vi.fn()
    const getOrder = vi.fn((sectionId: string) => {
      if (sectionId === 'medium') return ['task-1']
      if (sectionId === 'high') return ['task-2', 'task-3']
      return undefined
    })

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder,
        getOrder
      })
    )

    const event = createDragEvent({
      active: {
        id: 'task-1',
        data: {
          current: {
            type: 'task',
            sectionId: 'medium',
            sectionTaskIds: ['task-1'],
            task: tasks[0]
          }
        }
      },
      over: {
        id: 'task-2',
        data: {
          current: {
            type: 'task',
            sectionId: 'high',
            sectionTaskIds: ['task-2', 'task-3'],
            columnId: 'priority-high',
            task: tasks[1]
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(
        event,
        createDragState({
          sourceContainerId: 'medium',
          overSectionId: 'high',
          overColumnId: 'priority-high',
          overTaskEdge: 'before'
        })
      )
    })

    onUpdateTask.mockClear()
    onReorder.mockClear()

    act(() => {
      result.current.undo()
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'medium' })
    expect(onReorder).toHaveBeenCalledWith({
      medium: ['task-1'],
      high: ['task-2', 'task-3']
    })
  })
})
