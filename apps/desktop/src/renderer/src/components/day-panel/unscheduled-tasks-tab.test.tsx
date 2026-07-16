import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { UnscheduledTasksTab } from './unscheduled-tasks-tab'

const mockListTasks = vi.hoisted(() => vi.fn())

const taskEventMocks = vi.hoisted(() => ({
  onTaskCreated: vi.fn(() => vi.fn()),
  onTaskUpdated: vi.fn(() => vi.fn()),
  onTaskDeleted: vi.fn(() => vi.fn()),
  onTaskCompleted: vi.fn(() => vi.fn())
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: mockListTasks
  },
  onTaskCreated: taskEventMocks.onTaskCreated,
  onTaskUpdated: taskEventMocks.onTaskUpdated,
  onTaskDeleted: taskEventMocks.onTaskDeleted,
  onTaskCompleted: taskEventMocks.onTaskCompleted
}))

// Mirrors draggable-task-chip.test.tsx: the DOM `data-task-id` attribute and the
// `useDraggable({ id, data })` call are two separate references to task.id in the
// source. Mocking useDraggable captures exactly what dnd-kit was registered with,
// so a regression that keeps the DOM attribute but drifts the drag payload (which
// is what contexts/drag-context.tsx and handleDragEnd's 'date' case actually read)
// still fails the test.
const dndMocks = vi.hoisted(() => ({
  useDraggable: vi.fn((_config: unknown) => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  useDraggable: dndMocks.useDraggable
}))

interface DraggableConfig {
  id: string
  data: { type: string; sourceType: string; taskId: string }
}

function lastDraggableConfig(): DraggableConfig {
  const call = dndMocks.useDraggable.mock.calls.at(-1)
  if (!call) throw new Error('useDraggable was not called')
  return call[0] as DraggableConfig
}

describe('UnscheduledTasksTab', () => {
  beforeEach(() => {
    dndMocks.useDraggable.mockClear()
    mockListTasks.mockReset()
    taskEventMocks.onTaskCreated.mockClear()
    taskEventMocks.onTaskUpdated.mockClear()
    taskEventMocks.onTaskDeleted.mockClear()
    taskEventMocks.onTaskCompleted.mockClear()
    mockListTasks.mockResolvedValue({
      tasks: [{ id: 'task-1', title: 'Write the spec', priority: 0, projectId: 'project-1' }],
      total: 1,
      hasMore: false
    })
  })

  it('lists unscheduled tasks as draggable rows', async () => {
    renderWithProviders(<UnscheduledTasksTab />)

    const row = await screen.findByTestId('unscheduled-task-row')
    expect(row).toHaveAttribute('data-task-id', 'task-1')
    expect(screen.getByText('Write the spec')).toBeInTheDocument()

    const config = lastDraggableConfig()
    expect(config.id).toBe('task-1')
    expect(config.data).toEqual({
      type: 'calendar-task',
      sourceType: 'list',
      taskId: 'task-1'
    })
  })

  it('requests only tasks without a due date', async () => {
    renderWithProviders(<UnscheduledTasksTab />)

    await screen.findByTestId('unscheduled-task-row')
    expect(mockListTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        unscheduled: true,
        includeCompleted: false,
        includeArchived: false
      })
    )
  })

  it('shows an empty state when there are no unscheduled tasks', async () => {
    mockListTasks.mockResolvedValue({ tasks: [], total: 0, hasMore: false })

    renderWithProviders(<UnscheduledTasksTab />)

    await waitFor(() => expect(mockListTasks).toHaveBeenCalled())
    expect(screen.queryByTestId('unscheduled-task-row')).not.toBeInTheDocument()
  })

  it('refetches when a task-updated event fires (e.g. dragged onto the calendar)', async () => {
    renderWithProviders(<UnscheduledTasksTab />)

    await screen.findByTestId('unscheduled-task-row')
    expect(mockListTasks).toHaveBeenCalledTimes(1)

    expect(taskEventMocks.onTaskUpdated).toHaveBeenCalledTimes(1)
    const handler = taskEventMocks.onTaskUpdated.mock.calls[0][0] as () => void

    handler()

    await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(2))
  })
})
