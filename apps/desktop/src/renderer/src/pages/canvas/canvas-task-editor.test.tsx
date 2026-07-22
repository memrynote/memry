import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasTaskEditor } from './canvas-task-editor'
import type { Task } from '@/data/task-model'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn()
}))

let currentTask: Task | null = null

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({
    tasks: currentTask ? [currentTask] : [],
    projects: [{ id: 'p1', statuses: [] }]
  }),
  useTaskWorkspaceMutations: () => ({ updateTask: mocks.updateTask })
}))

vi.mock('@/components/tasks/interactive-status-badge', () => ({
  InteractiveStatusBadge: ({ onStatusChange }: { onStatusChange: (id: string) => void }) => (
    <button data-testid="status-badge" onClick={() => onStatusChange('done')} />
  )
}))
vi.mock('@/components/tasks/interactive-priority-badge', () => ({
  InteractivePriorityBadge: ({ onPriorityChange }: { onPriorityChange: (p: string) => void }) => (
    <button data-testid="priority-badge" onClick={() => onPriorityChange('high')} />
  )
}))
vi.mock('@/components/tasks/interactive-due-date-badge', () => ({
  InteractiveDueDateBadge: ({
    onDateChange,
    onTimeChange
  }: {
    onDateChange: (d: Date | null) => void
    onTimeChange: (t: string | null) => void
  }) => (
    <>
      <button data-testid="date-badge" onClick={() => onDateChange(new Date('2026-08-01'))} />
      <button data-testid="time-badge" onClick={() => onTimeChange('09:00')} />
    </>
  )
}))
vi.mock('@/components/tasks/task-description-editor', () => ({
  TaskDescriptionEditor: ({ onContentChange }: { onContentChange: (markdown: string) => void }) => (
    <button data-testid="description-editor" onClick={() => onContentChange('new body')} />
  )
}))

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Original title',
    description: 'orig body',
    projectId: 'p1',
    statusId: 's1',
    priority: 'none',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    tags: [],
    parentId: null,
    subtaskIds: [],
    createdAt: new Date('2026-01-01'),
    completedAt: null,
    archivedAt: null,
    ...overrides
  }
}

describe('CanvasTaskEditor', () => {
  beforeEach(() => {
    mocks.updateTask.mockReset()
    currentTask = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a loading state when the task is not (yet) found', () => {
    render(<CanvasTaskEditor taskId="missing" />)
    expect(screen.getByText('state.loading')).toBeInTheDocument()
  })

  it('renders the task title and updates it on change', () => {
    currentTask = makeTask()
    render(<CanvasTaskEditor taskId="t1" />)
    const input = screen.getByDisplayValue('Original title')
    fireEvent.change(input, { target: { value: 'New title' } })
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { title: 'New title' })
  })

  it('wires the status/priority/due-date badges to updateTask', () => {
    currentTask = makeTask()
    render(<CanvasTaskEditor taskId="t1" />)
    fireEvent.click(screen.getByTestId('status-badge'))
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { statusId: 'done' })
    fireEvent.click(screen.getByTestId('priority-badge'))
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { priority: 'high' })
    fireEvent.click(screen.getByTestId('date-badge'))
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { dueDate: new Date('2026-08-01') })
    fireEvent.click(screen.getByTestId('time-badge'))
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { dueTime: '09:00' })
  })

  it('debounces the description change before persisting', () => {
    vi.useFakeTimers()
    currentTask = makeTask()
    render(<CanvasTaskEditor taskId="t1" />)
    fireEvent.click(screen.getByTestId('description-editor'))
    expect(mocks.updateTask).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { description: 'new body' })
  })

  it('flushes a pending description edit on unmount', () => {
    vi.useFakeTimers()
    currentTask = makeTask()
    const { unmount } = render(<CanvasTaskEditor taskId="t1" />)
    fireEvent.click(screen.getByTestId('description-editor'))
    unmount()
    expect(mocks.updateTask).toHaveBeenCalledWith('t1', { description: 'new body' })
  })
})
