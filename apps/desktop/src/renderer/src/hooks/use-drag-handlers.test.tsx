import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { DragEndEvent } from '@dnd-kit/core'

import { useDragHandlers } from './use-drag-handlers'
import { CANVAS_DROP_DATA } from '@/pages/canvas/canvas-drop-entity'
import type { DragState } from '@/contexts/drag-context'
import type { Priority, Task } from '@/data/task-model'
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
  it('ignores missing drop targets and exposes no-op drag lifecycle handlers', () => {
    const onUpdateTask = vi.fn()
    const onDeleteTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks: [createTask()],
        projects: [createProject()],
        onUpdateTask,
        onDeleteTask,
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(createDragEvent({ over: null }), createDragState())
      result.current.handleDragStart({} as never, createDragState())
      result.current.handleDragOver({} as never, createDragState())
      result.current.undo()
    })

    expect(onUpdateTask).not.toHaveBeenCalled()
    expect(onDeleteTask).not.toHaveBeenCalled()
    expect(onReorder).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('leaves a task untouched when it is dropped on a spatial canvas', () => {
    // A canvas drop only creates a referencing card (canvas-card-overlay owns
    // that through useDndMonitor). The task itself must not be rescheduled,
    // reordered, moved between projects, or trashed on the way past.
    const onUpdateTask = vi.fn()
    const onDeleteTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks: [createTask()],
        projects: [createProject()],
        onUpdateTask,
        onDeleteTask,
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: { id: 'task-1', data: { current: { type: 'task', task: createTask() } } },
          over: { id: 'canvas-drop-1', data: { current: CANVAS_DROP_DATA } }
        }),
        createDragState({ overType: null, overId: 'canvas-drop-1', overSectionId: null })
      )
    })

    expect(onUpdateTask).not.toHaveBeenCalled()
    expect(onDeleteTask).not.toHaveBeenCalled()
    expect(onReorder).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('inserts active task ids that are missing from the known same-section order', () => {
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks: [createTask({ id: 'task-new' }), createTask({ id: 'task-1' })],
        projects: [createProject()],
        onUpdateTask: vi.fn(),
        onDeleteTask: vi.fn(),
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-new',
            data: { current: { sectionTaskIds: ['task-1', 'task-2'] } }
          },
          over: {
            id: 'task-1',
            data: {
              current: {
                type: 'task',
                columnId: 'same-column',
                sectionTaskIds: ['task-1', 'task-2']
              }
            }
          }
        }),
        createDragState({
          activeId: 'task-new',
          activeIds: ['task-new'],
          sourceContainerId: 'same-column',
          overTaskEdge: 'after'
        })
      )
    })

    expect(onReorder).toHaveBeenCalledWith({ 'same-column': ['task-new', 'task-1', 'task-2'] })
  })

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

  it('falls back to active and over ids when same-section order metadata is absent', () => {
    const project = createProject()
    const tasks = [createTask({ id: 'task-1' }), createTask({ id: 'task-2' })]
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask: vi.fn(),
        onDeleteTask: vi.fn(),
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: { current: { sectionTaskIds: [] } }
          },
          over: {
            id: 'task-2',
            data: {
              current: {
                type: 'task',
                sectionId: 'todo',
                sectionTaskIds: [],
                task: tasks[1]
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-1'],
          sourceContainerId: 'todo',
          overSectionId: 'todo'
        })
      )
    })

    expect(onReorder).toHaveBeenCalledWith({ todo: ['task-1', 'task-2'] })
  })

  it('places same-section moves after the hovered task and ignores unknown hover ids', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1' }),
      createTask({ id: 'task-2' }),
      createTask({ id: 'task-3' })
    ]
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask: vi.fn(),
        onDeleteTask: vi.fn(),
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: { current: { sectionTaskIds: ['task-1', 'task-2', 'task-3'] } }
          },
          over: {
            id: 'task-2',
            data: {
              current: {
                type: 'task',
                sectionId: 'todo',
                sectionTaskIds: ['task-1', 'task-2', 'task-3'],
                task: tasks[1]
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-1'],
          sourceContainerId: 'todo',
          overSectionId: 'todo',
          overTaskEdge: 'after'
        })
      )
    })

    expect(onReorder).toHaveBeenLastCalledWith({ todo: ['task-2', 'task-1', 'task-3'] })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: { current: { sectionTaskIds: ['task-1', 'task-2', 'task-3'] } }
          },
          over: {
            id: 'missing-task',
            data: {
              current: {
                type: 'task',
                sectionId: 'todo',
                sectionTaskIds: ['task-1', 'task-2', 'task-3']
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-1'],
          sourceContainerId: 'todo',
          overSectionId: 'todo'
        })
      )
    })

    expect(onReorder).toHaveBeenLastCalledWith({ todo: ['task-1', 'task-2', 'task-3'] })
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

  it('handles multi-task cross-section due-date drops and restores previous dates on undo', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', dueDate: null }),
      createTask({ id: 'task-2', dueDate: new Date('2026-04-11T00:00:00.000Z') }),
      createTask({ id: 'task-3', dueDate: new Date('2026-04-20T00:00:00.000Z') })
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

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: {
              current: {
                sectionTaskIds: ['task-1', 'task-2']
              }
            }
          },
          over: {
            id: 'due-tomorrow',
            data: {
              current: {
                type: 'column',
                sectionId: 'tomorrow',
                sectionTaskIds: ['task-3'],
                columnId: 'due-tomorrow'
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-1', 'task-2'],
          sourceContainerId: 'today',
          overType: 'column',
          overSectionId: 'tomorrow',
          overColumnId: 'due-tomorrow',
          sectionDropPosition: 'end'
        })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: expect.any(Date) })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { dueDate: expect.any(Date) })
    expect(onReorder).toHaveBeenCalledWith({
      today: [],
      tomorrow: ['task-3', 'task-1', 'task-2']
    })

    onUpdateTask.mockClear()
    onReorder.mockClear()
    act(() => {
      result.current.undo()
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: null })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', {
      dueDate: new Date('2026-04-11T00:00:00.000Z')
    })
    expect(onReorder).toHaveBeenCalledWith({ today: null, tomorrow: null })
  })

  it('updates the task due datetime when a calendar task is dropped onto a date cell', () => {
    const project = createProject()
    const tasks = [
      createTask({
        id: 'task-1',
        dueDate: new Date('2026-04-14T15:30:00.000Z'),
        dueTime: '15:30'
      })
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
      active: {
        id: 'task-1',
        data: {
          current: {
            type: 'calendar-task',
            sourceType: 'calendar',
            task: tasks[0]
          }
        }
      },
      over: {
        id: 'date-2026-04-18',
        data: {
          current: {
            type: 'date',
            date: new Date('2026-04-18T00:00:00.000Z')
          }
        }
      }
    })

    act(() => {
      result.current.handleDragEnd(
        event,
        createDragState({
          sourceType: 'calendar',
          sourceContainerId: '2026-04-14',
          overId: 'date-2026-04-18',
          overType: 'date'
        })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date(2026, 3, 18, 15, 30)
    })
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

  it('clears and replaces the dropped-priority flash when another priority drop happens', () => {
    vi.useFakeTimers()
    const project = createProject()
    const tasks = [createTask({ id: 'task-1', priority: 'low' })]
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

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'priority-none',
            data: { current: { type: 'column', columnId: 'priority-none' } }
          }
        }),
        createDragState({ sourceContainerId: 'priority-low' })
      )
    })
    expect(result.current.droppedPriorities.get('task-1')).toBe('none')

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'priority-high',
            data: { current: { type: 'column', columnId: 'priority-high' } }
          }
        }),
        createDragState({ sourceContainerId: 'priority-none' })
      )
    })
    expect(result.current.droppedPriorities.get('task-1')).toBe('high')

    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(result.current.droppedPriorities.size).toBe(0)
    vi.useRealTimers()
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'none' })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
  })

  it('handles cross-section canonical and project-status drops, including completion toggles', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', statusId: 'p1-todo', completedAt: null }),
      createTask({
        id: 'task-2',
        statusId: 'p1-done',
        completedAt: new Date('2026-04-10T00:00:00.000Z')
      })
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

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: { current: { sectionTaskIds: ['task-1'] } }
          },
          over: {
            id: 'done',
            data: {
              current: {
                type: 'column',
                sectionId: 'done',
                columnId: 'done',
                sectionTaskIds: []
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-1'],
          sourceContainerId: 'todo',
          overType: 'column',
          overSectionId: 'done',
          overColumnId: 'done'
        })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ statusId: 'p1-done', completedAt: expect.any(Date) })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-2',
            data: { current: { sectionTaskIds: ['task-2'] } }
          },
          over: {
            id: 'p1-progress',
            data: {
              current: {
                type: 'column',
                sectionId: 'p1-progress',
                columnId: 'p1-progress',
                sectionTaskIds: []
              }
            }
          }
        }),
        createDragState({
          activeIds: ['task-2'],
          sourceContainerId: 'p1-done',
          overType: 'column',
          overSectionId: 'p1-progress',
          overColumnId: 'p1-progress'
        })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', {
      statusId: 'p1-progress',
      completedAt: null
    })
  })

  it('reschedules cross-section task drops from the hovered task when no column mapping exists', () => {
    const project = createProject()
    const targetDueDate = new Date('2026-04-25T00:00:00.000Z')
    const tasks = [
      createTask({ id: 'task-1', dueDate: null }),
      createTask({ id: 'task-2', dueDate: targetDueDate })
    ]
    const onUpdateTask = vi.fn()
    const onReorder = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask: vi.fn(),
        onReorder
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          active: {
            id: 'task-1',
            data: { current: { sectionTaskIds: ['task-1'] } }
          },
          over: {
            id: 'task-2',
            data: {
              current: {
                type: 'task',
                sectionId: 'later',
                sectionTaskIds: ['task-2'],
                task: tasks[1]
              }
            }
          }
        }),
        createDragState({
          sourceContainerId: 'today',
          overSectionId: 'later',
          overTaskEdge: 'after'
        })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: targetDueDate })
    expect(onReorder).toHaveBeenCalledWith({ today: [], later: ['task-1', 'task-2'] })
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

  it('keeps the hovered row insertion target when mouseup resolves to the section header', () => {
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
          overId: 'task-3',
          overType: 'task',
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

  it('handles section, weekday, trash, and archive drops with undo for archived tasks', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', dueDate: new Date('2026-04-14T00:00:00.000Z') }),
      createTask({ id: 'task-2', dueDate: null })
    ]
    const onUpdateTask = vi.fn()
    const onDeleteTask = vi.fn()

    const { result } = renderHook(() =>
      useDragHandlers({
        tasks,
        projects: [project],
        onUpdateTask,
        onDeleteTask,
        onReorder: vi.fn()
      })
    )

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'section-no-date',
            data: { current: { type: 'section', date: null, label: 'No date' } }
          }
        }),
        createDragState({ overType: 'section' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: null })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'weekday-tomorrow',
            data: {
              current: {
                type: 'weekday',
                date: new Date('2026-04-20T00:00:00.000Z'),
                label: 'Tomorrow'
              }
            }
          }
        }),
        createDragState({ activeIds: ['task-2'], overType: 'date' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', {
      dueDate: new Date('2026-04-20T00:00:00.000Z')
    })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: { id: 'trash', data: { current: { type: 'trash' } } }
        }),
        createDragState({ activeIds: ['task-2'], overType: 'trash' })
      )
    })
    expect(onDeleteTask).toHaveBeenCalledWith('task-2')

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: { id: 'archive', data: { current: { type: 'archive' } } }
        }),
        createDragState({ activeIds: ['task-2'], overType: 'archive' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { archivedAt: expect.any(Date) })
    expect(result.current.canUndo).toBe(true)

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { archivedAt: null })
  })

  it('undoes project moves, status changes, priority changes, and reschedules', () => {
    const projectOne = createProject()
    const projectTwo = createProject({
      id: 'project-2',
      name: 'Project 2',
      statuses: [
        createStatus({ id: 'p2-todo', type: 'todo', name: 'To Do', order: 0 }),
        createStatus({ id: 'p2-done', type: 'done', name: 'Done', order: 1 })
      ]
    })
    const tasks = [
      createTask({ id: 'task-1', projectId: 'project-1', statusId: 'p1-todo' }),
      createTask({
        id: 'task-2',
        projectId: 'project-1',
        statusId: 'p1-progress',
        priority: 'low',
        dueDate: new Date('2026-04-14T00:00:00.000Z')
      })
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

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'project-2',
            data: { current: { type: 'project', projectId: 'project-2' } }
          }
        }),
        createDragState({ activeIds: ['task-1'], overType: 'project' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      projectId: 'project-2',
      statusId: 'p2-todo'
    })

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      projectId: 'project-1',
      statusId: 'p1-todo'
    })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: { id: 'done', data: { current: { type: 'column', columnId: 'done' } } }
        }),
        createDragState({ activeIds: ['task-2'], sourceContainerId: 'todo', overType: 'column' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith(
      'task-2',
      expect.objectContaining({ statusId: 'p1-done', completedAt: expect.any(Date) })
    )

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { statusId: 'p1-progress' })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'priority-urgent',
            data: { current: { type: 'column', columnId: 'priority-urgent' } }
          }
        }),
        createDragState({ activeIds: ['task-2'], sourceContainerId: 'priority-low' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { priority: 'urgent' })

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { priority: 'low' })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'due-today',
            data: {
              current: {
                type: 'column',
                columnId: 'due-today',
                label: 'Today'
              }
            }
          }
        }),
        createDragState({ activeIds: ['task-2'], sourceContainerId: 'due-overdue' })
      )
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', { dueDate: expect.any(Date) })

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-2', {
      dueDate: new Date('2026-04-14T00:00:00.000Z')
    })
  })

  it('handles direct project-status column drops and undo status restoration', () => {
    const project = createProject()
    const tasks = [
      createTask({ id: 'task-1', statusId: 'p1-todo', completedAt: null }),
      createTask({
        id: 'task-2',
        statusId: 'p1-done',
        completedAt: new Date('2026-04-10T00:00:00.000Z')
      })
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

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'p1-done',
            data: { current: { type: 'column', columnId: 'p1-done' } }
          }
        }),
        createDragState({ activeIds: ['task-1'], sourceContainerId: 'p1-todo' })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ statusId: 'p1-done', completedAt: expect.any(Date) })
    )

    onUpdateTask.mockClear()
    act(() => {
      result.current.undo()
    })
    expect(onUpdateTask).toHaveBeenCalledWith('task-1', { statusId: 'p1-todo' })

    act(() => {
      result.current.handleDragEnd(
        createDragEvent({
          over: {
            id: 'p1-progress',
            data: { current: { type: 'column', columnId: 'p1-progress' } }
          }
        }),
        createDragState({ activeIds: ['task-2'], sourceContainerId: 'p1-done' })
      )
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-2', {
      statusId: 'p1-progress',
      completedAt: null
    })
  })

  describe('kanban cross-column drops', () => {
    it('respects drop position when dragging task across kanban columns', () => {
      const project = createProject()
      const tasks = [
        createTask({ id: 'task-1', priority: 'high' }),
        createTask({ id: 'task-2', priority: 'medium' }),
        createTask({ id: 'task-3', priority: 'medium' })
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
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-1'],
              columnId: 'priority-high',
              task: tasks[0]
            }
          }
        },
        over: {
          id: 'task-3',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-medium',
              sectionTaskIds: ['task-2', 'task-3'],
              columnId: 'priority-medium',
              task: tasks[2]
            }
          }
        }
      })

      act(() => {
        result.current.handleDragEnd(
          event,
          createDragState({
            sourceType: 'kanban',
            sourceContainerId: 'priority-high',
            overSectionId: 'priority-medium',
            overColumnId: 'priority-medium',
            overTaskEdge: 'before'
          })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'medium' })
      expect(onReorder).toHaveBeenCalledWith({
        'priority-high': [],
        'priority-medium': ['task-2', 'task-1', 'task-3']
      })
    })

    it('places task at start when dropping on kanban column area', () => {
      const project = createProject()
      const tasks = [
        createTask({ id: 'task-1', priority: 'high' }),
        createTask({ id: 'task-2', priority: 'medium' }),
        createTask({ id: 'task-3', priority: 'medium' })
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
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-1'],
              columnId: 'priority-high',
              task: tasks[0]
            }
          }
        },
        over: {
          id: 'column-priority-medium',
          data: {
            current: {
              type: 'column',
              sectionId: 'priority-medium',
              sectionTaskIds: ['task-2', 'task-3'],
              columnId: 'priority-medium'
            }
          }
        }
      })

      act(() => {
        result.current.handleDragEnd(
          event,
          createDragState({
            sourceType: 'kanban',
            sourceContainerId: 'priority-high',
            overId: 'column-priority-medium',
            overType: 'column',
            overSectionId: 'priority-medium',
            overColumnId: 'priority-medium',
            sectionDropPosition: 'start'
          })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'medium' })
      expect(onReorder).toHaveBeenCalledWith({
        'priority-high': [],
        'priority-medium': ['task-1', 'task-2', 'task-3']
      })
    })

    it('respects position when returning task to original kanban column', () => {
      const project = createProject()
      const tasks = [
        createTask({ id: 'task-1', priority: 'medium' }),
        createTask({ id: 'task-2', priority: 'medium' }),
        createTask({ id: 'task-3', priority: 'high' }),
        createTask({ id: 'task-4', priority: 'high' })
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
              sourceType: 'kanban',
              sectionId: 'priority-medium',
              sectionTaskIds: ['task-1', 'task-2'],
              columnId: 'priority-medium',
              task: tasks[0]
            }
          }
        },
        over: {
          id: 'task-4',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-3', 'task-4'],
              columnId: 'priority-high',
              task: tasks[3]
            }
          }
        }
      })

      act(() => {
        result.current.handleDragEnd(
          event,
          createDragState({
            sourceType: 'kanban',
            sourceContainerId: 'priority-medium',
            overSectionId: 'priority-high',
            overColumnId: 'priority-high',
            overTaskEdge: 'before'
          })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'high' })
      expect(onReorder).toHaveBeenCalledWith({
        'priority-medium': ['task-2'],
        'priority-high': ['task-3', 'task-1', 'task-4']
      })

      onUpdateTask.mockClear()
      onReorder.mockClear()

      const returnEvent = createDragEvent({
        active: {
          id: 'task-1',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-3', 'task-1', 'task-4'],
              columnId: 'priority-high',
              task: { ...tasks[0], priority: 'high' as Priority }
            }
          }
        },
        over: {
          id: 'task-2',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-medium',
              sectionTaskIds: ['task-2'],
              columnId: 'priority-medium',
              task: tasks[1]
            }
          }
        }
      })

      act(() => {
        result.current.handleDragEnd(
          returnEvent,
          createDragState({
            activeId: 'task-1',
            activeIds: ['task-1'],
            sourceType: 'kanban',
            sourceContainerId: 'priority-high',
            overId: 'task-2',
            overSectionId: 'priority-medium',
            overColumnId: 'priority-medium',
            overTaskEdge: 'before'
          })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'medium' })
      expect(onReorder).toHaveBeenCalledWith({
        'priority-high': ['task-3', 'task-4'],
        'priority-medium': ['task-1', 'task-2']
      })
    })

    it('handles same-column reorder in kanban with sectionId present', () => {
      const project = createProject()
      const tasks = [
        createTask({ id: 'task-1', priority: 'high' }),
        createTask({ id: 'task-2', priority: 'high' }),
        createTask({ id: 'task-3', priority: 'high' })
      ]
      const onReorder = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [project],
          onUpdateTask: vi.fn(),
          onDeleteTask: vi.fn(),
          onReorder
        })
      )

      const event = createDragEvent({
        active: {
          id: 'task-3',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-1', 'task-2', 'task-3'],
              columnId: 'priority-high',
              task: tasks[2]
            }
          }
        },
        over: {
          id: 'task-1',
          data: {
            current: {
              type: 'task',
              sourceType: 'kanban',
              sectionId: 'priority-high',
              sectionTaskIds: ['task-1', 'task-2', 'task-3'],
              columnId: 'priority-high',
              task: tasks[0]
            }
          }
        }
      })

      act(() => {
        result.current.handleDragEnd(
          event,
          createDragState({
            activeId: 'task-3',
            activeIds: ['task-3'],
            sourceType: 'kanban',
            sourceContainerId: 'priority-high',
            overSectionId: 'priority-high',
            overColumnId: 'priority-high',
            overTaskEdge: 'before'
          })
        )
      })

      expect(onReorder).toHaveBeenCalledWith({
        'priority-high': ['task-3', 'task-1', 'task-2']
      })
    })
  })

  describe('handleDateDrop time handling', () => {
    it('leaves dueTime untouched when no time option is given', () => {
      const tasks = [
        createTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      act(() => {
        result.current.handleDragEnd(
          createDragEvent({
            over: {
              id: 'date-2026-07-15',
              data: {
                current: {
                  type: 'date',
                  date: new Date('2026-07-15T00:00:00')
                }
              }
            }
          }),
          createDragState({ overType: 'date' })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-15T09:00:00')
      })
    })

    it('clears dueTime when the drop target specifies dueTime: null', () => {
      const tasks = [
        createTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      act(() => {
        result.current.handleDragEnd(
          createDragEvent({
            over: {
              id: 'date-2026-07-15',
              data: {
                current: {
                  type: 'date',
                  date: new Date('2026-07-15T00:00:00'),
                  dueTime: null
                }
              }
            }
          }),
          createDragState({ overType: 'date' })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-15T00:00:00'),
        dueTime: null
      })
    })

    it('sets dueTime when the drop target specifies a time string', () => {
      const tasks = [createTask({ id: 'task-1', dueDate: null, dueTime: null })]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      act(() => {
        result.current.handleDragEnd(
          createDragEvent({
            over: {
              id: 'date-2026-07-15',
              data: {
                current: {
                  type: 'date',
                  date: new Date('2026-07-15T00:00:00'),
                  dueTime: '14:30'
                }
              }
            }
          }),
          createDragState({ overType: 'date' })
        )
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-15T14:30:00'),
        dueTime: '14:30'
      })
    })

    it('restores both date and time on undo of a time-changing drop', () => {
      const tasks = [
        createTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      act(() => {
        result.current.handleDragEnd(
          createDragEvent({
            over: {
              id: 'date-2026-07-15',
              data: {
                current: {
                  type: 'date',
                  date: new Date('2026-07-15T00:00:00'),
                  dueTime: null
                }
              }
            }
          }),
          createDragState({ overType: 'date' })
        )
      })

      onUpdateTask.mockClear()
      act(() => {
        result.current.undo()
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-10T00:00:00'),
        dueTime: '09:00'
      })
    })
  })

  describe('timed column slot drops', () => {
    it('resolves dueTime from where the chip landed in a timeBehavior: "slot" column', () => {
      const tasks = [
        createTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '15:30' })
      ]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      // Column top is at 0; the chip's translated top sits 9 hours down at
      // hourHeight: 48 (9 * 48 = 432px) — should resolve to 09:00.
      const event = {
        over: {
          id: 'calendar-timed-column:2026-07-15',
          data: {
            current: {
              type: 'date',
              date: new Date('2026-07-15T00:00:00'),
              dateKey: '2026-07-15',
              timeBehavior: 'slot',
              hourHeight: 48
            }
          },
          rect: { top: 0 }
        },
        active: {
          id: 'task-1',
          data: { current: {} },
          rect: { current: { translated: { top: 432 } } }
        }
      } as unknown as DragEndEvent

      act(() => {
        result.current.handleDragEnd(event, createDragState({ overType: 'date' }))
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-15T09:00:00'),
        dueTime: '09:00'
      })
    })

    it('preserves the existing dueTime when the slot column rects are unavailable', () => {
      const tasks = [
        createTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
      const onUpdateTask = vi.fn()

      const { result } = renderHook(() =>
        useDragHandlers({
          tasks,
          projects: [createProject()],
          onUpdateTask,
          onDeleteTask: vi.fn(),
          onReorder: vi.fn()
        })
      )

      // active.rect.current.translated is null, as dnd-kit reports before the
      // dragged node has been measured — the deliberate "keep current time"
      // fallback, versus silently scheduling at midnight.
      const event = {
        over: {
          id: 'calendar-timed-column:2026-07-20',
          data: {
            current: {
              type: 'date',
              date: new Date('2026-07-20T00:00:00'),
              dateKey: '2026-07-20',
              timeBehavior: 'slot',
              hourHeight: 48
            }
          },
          rect: { top: 0 }
        },
        active: {
          id: 'task-1',
          data: { current: {} },
          rect: { current: { translated: null } }
        }
      } as unknown as DragEndEvent

      act(() => {
        result.current.handleDragEnd(event, createDragState({ overType: 'date' }))
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        dueDate: new Date('2026-07-20T09:00:00')
      })
    })
  })
})
