import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TaskRow } from './task-row'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, StatusType, Status } from '@/data/tasks-data'

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
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createStatus({ id: 'p1-todo', name: 'To Do', type: 'todo', order: 0 }),
    createStatus({ id: 'p1-done', name: 'Done', type: 'done', order: 1 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'p1-todo',
  priority: 'medium' as Priority,
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

const defaultProps = {
  task: createTask(),
  project: createProject(),
  projects: [createProject()],
  isCompleted: false,
  onToggleComplete: vi.fn(),
  onClick: vi.fn()
}

describe('TaskRow — Drag Handle', () => {
  it('renders a drag handle element', () => {
    render(<TaskRow {...defaultProps} showDragHandle />)

    expect(screen.getByTestId('drag-handle')).toBeInTheDocument()
  })

  it('does not render drag handle when showDragHandle is false', () => {
    render(<TaskRow {...defaultProps} showDragHandle={false} />)

    expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
  })

  it('does not render drag handle by default', () => {
    render(<TaskRow {...defaultProps} />)

    expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
  })

  it('passes drag handle listeners to the handle element', () => {
    const listeners = { onPointerDown: vi.fn() }
    render(<TaskRow {...defaultProps} showDragHandle dragHandleListeners={listeners} />)

    const handle = screen.getByTestId('drag-handle')
    expect(handle).toBeInTheDocument()
  })
})

describe('TaskRow — isDragging (Source Placeholder)', () => {
  it('applies placeholder styling when isDragging is true', () => {
    render(<TaskRow {...defaultProps} isDragging />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).toContain('opacity-35')
    expect(row.className).toContain('border-dashed')
  })

  it('does not apply placeholder styling when isDragging is false', () => {
    render(<TaskRow {...defaultProps} isDragging={false} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).not.toContain('opacity-35')
    expect(row.className).not.toContain('border-dashed')
  })
})

describe('TaskRow — isJustDropped (Flash Animation)', () => {
  it('applies drop flash animation when isJustDropped is true', () => {
    render(<TaskRow {...defaultProps} isJustDropped />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).toContain('animate-row-drop-flash')
  })

  it('does not apply flash animation when isJustDropped is false', () => {
    render(<TaskRow {...defaultProps} isJustDropped={false} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).not.toContain('animate-row-drop-flash')
  })
})

describe('TaskRow — Priority Change Badge', () => {
  it('shows transient priority badge when droppedPriority is set', () => {
    render(<TaskRow {...defaultProps} droppedPriority="high" />)

    expect(screen.getByText('priority: High')).toBeInTheDocument()
  })

  it('does not show priority badge by default', () => {
    render(<TaskRow {...defaultProps} />)

    expect(screen.queryByText(/priority:/i)).not.toBeInTheDocument()
  })
})

describe('TaskRow — List Drop Indicators', () => {
  it('renders a reorder insertion indicator when requested', () => {
    render(<TaskRow {...defaultProps} insertionIndicatorPosition="before" />)

    expect(screen.getByTestId('list-drop-indicator')).toHaveAttribute(
      'data-drop-indicator',
      'reorder'
    )
  })

  it('renders a cross-section drop band when hovering another list target', () => {
    render(<TaskRow {...defaultProps} isCrossSectionTarget />)

    expect(screen.getByTestId('list-drop-indicator')).toHaveAttribute(
      'data-drop-indicator',
      'column'
    )
  })
})

describe('TaskRow — memo equality with drag props', () => {
  it('re-renders when isDragging changes', () => {
    const { rerender } = render(<TaskRow {...defaultProps} isDragging={false} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).not.toContain('opacity-35')

    rerender(<TaskRow {...defaultProps} isDragging={true} />)
    expect(screen.getByLabelText(/^Task: Test Task/).className).toContain('opacity-35')
  })

  it('re-renders when isJustDropped changes', () => {
    const { rerender } = render(<TaskRow {...defaultProps} isJustDropped={false} />)

    expect(screen.getByLabelText(/^Task: Test Task/).className).not.toContain(
      'animate-row-drop-flash'
    )

    rerender(<TaskRow {...defaultProps} isJustDropped={true} />)
    expect(screen.getByLabelText(/^Task: Test Task/).className).toContain('animate-row-drop-flash')
  })
})
