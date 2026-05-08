import userEvent from '@testing-library/user-event'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TaskRow } from './task-row'
import { notesService } from '@/services/notes-service'
import type { Task, Priority } from '@/data/task-model'
import type { Project, StatusType, Status } from '@/data/tasks-data'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: vi.fn()
  }
}))

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

const createNote = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'note-1',
    title: 'Linked Note',
    emoji: null,
    ...overrides
  }) as Awaited<ReturnType<typeof notesService.get>>

beforeEach(() => {
  vi.mocked(notesService.get).mockReset()
  vi.mocked(notesService.get).mockResolvedValue(null)
})

describe('TaskRow — Linked Notes', () => {
  it('shows the first linked note title and extra count', async () => {
    vi.mocked(notesService.get).mockResolvedValueOnce(createNote({ title: 'Planning Note' }))

    render(
      <TaskRow
        {...defaultProps}
        task={createTask({ linkedNoteIds: ['note-1', 'note-2'] })}
        onNoteClick={vi.fn()}
      />
    )

    expect(await screen.findByText('Planning Note')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('falls back to sourceNoteId when linkedNoteIds is empty', async () => {
    vi.mocked(notesService.get).mockResolvedValueOnce(createNote({ id: 'source-note' }))

    render(
      <TaskRow
        {...defaultProps}
        task={createTask({ linkedNoteIds: [], sourceNoteId: 'source-note' })}
        onNoteClick={vi.fn()}
      />
    )

    expect(await screen.findByText('Linked Note')).toBeInTheDocument()
    expect(notesService.get).toHaveBeenCalledWith('source-note')
  })

  it('opens the linked note without opening the task row', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onNoteClick = vi.fn()
    vi.mocked(notesService.get).mockResolvedValueOnce(createNote({ title: 'Research Note' }))

    render(
      <TaskRow
        {...defaultProps}
        task={createTask({ linkedNoteIds: ['note-1'] })}
        onClick={onClick}
        onNoteClick={onNoteClick}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Open note Research Note' }))

    expect(onNoteClick).toHaveBeenCalledWith('note-1')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('does not show a linked note affordance without note relationships', () => {
    render(<TaskRow {...defaultProps} onNoteClick={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /open note/i })).not.toBeInTheDocument()
  })
})

describe('TaskRow — Whole-Row Drag', () => {
  it('applies cursor-grab when dragHandleListeners are provided', () => {
    const listeners = { onPointerDown: vi.fn() }
    render(<TaskRow {...defaultProps} dragHandleListeners={listeners} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).toContain('cursor-grab')
  })

  it('does not render a grip icon', () => {
    render(<TaskRow {...defaultProps} />)

    expect(screen.queryByTestId('drag-handle')).not.toBeInTheDocument()
  })
})

describe('TaskRow — isDragging (Source Placeholder)', () => {
  it('applies placeholder styling when isDragging is true', () => {
    render(<TaskRow {...defaultProps} isDragging />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).toContain('opacity-[0.35]')
    expect(row.className).toContain('border-dashed')
  })

  it('does not apply placeholder styling when isDragging is false', () => {
    render(<TaskRow {...defaultProps} isDragging={false} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).not.toContain('opacity-[0.35]')
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

    expect(screen.getByLabelText(/^Task: Test Task/).className).toContain('pt-1')
    expect(screen.getByTestId('list-drop-indicator')).toHaveAttribute(
      'data-drop-indicator',
      'reorder'
    )
  })

  it('renders target-section styling when requested', () => {
    render(<TaskRow {...defaultProps} sectionDragState="target-highlighted" />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row).toHaveAttribute('data-section-drag-state', 'target-highlighted')
    expect(row.className).toContain('bg-primary/[0.04]')
  })

  it('dims source-section rows during a cross-section drag', () => {
    render(<TaskRow {...defaultProps} sectionDragState="source-dimmed" />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row).toHaveAttribute('data-section-drag-state', 'source-dimmed')
    expect(row.className).toContain('opacity-50')
  })
})

describe('TaskRow — Overlay Theme Styling', () => {
  it('uses theme tokens for the drag ghost instead of a fixed dark shell', () => {
    render(<TaskRow {...defaultProps} renderMode="overlay" dataTestId="drag-overlay" />)

    const overlay = screen.getByTestId('drag-overlay')
    expect(overlay.className).toContain('bg-card')
    expect(overlay.className).toContain('border-[#4C9EFF]')
    expect(overlay.className).not.toContain('bg-[#27272A]')
  })
})

describe('TaskRow — memo equality with drag props', () => {
  it('re-renders when isDragging changes', () => {
    const { rerender } = render(<TaskRow {...defaultProps} isDragging={false} />)

    const row = screen.getByLabelText(/^Task: Test Task/)
    expect(row.className).not.toContain('opacity-[0.35]')

    rerender(<TaskRow {...defaultProps} isDragging={true} />)
    expect(screen.getByLabelText(/^Task: Test Task/).className).toContain('opacity-[0.35]')
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
