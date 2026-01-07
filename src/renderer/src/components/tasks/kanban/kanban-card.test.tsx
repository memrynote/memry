/**
 * KanbanCard Component Tests (T515-T516)
 *
 * Tests for the KanbanCard component with task display and interactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KanbanCard } from './kanban-card'
import type { Task, Priority } from '@/data/sample-tasks'

// Mock dnd-kit
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: { role: 'option', 'aria-roledescription': 'sortable' },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false
  }),
  defaultAnimateLayoutChanges: vi.fn()
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => ''
    }
  }
}))

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// ============================================================================
// Test Data
// ============================================================================

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'status-1',
  priority: 'none' as Priority,
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
})

// ============================================================================
// T515: KanbanCard - Task Display Tests
// ============================================================================

describe('T515: KanbanCard - task display', () => {
  const defaultProps = {
    task: createTask(),
    columnId: 'column-1',
    onClick: vi.fn(),
    onDoubleClick: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render task title', () => {
    render(<KanbanCard {...defaultProps} />)

    expect(screen.getByText('Test Task')).toBeInTheDocument()
  })

  it('should render task with custom title', () => {
    const task = createTask({ title: 'Custom Task Title' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText('Custom Task Title')).toBeInTheDocument()
  })

  it('should render priority indicator for high priority', () => {
    const task = createTask({ priority: 'high' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('should render priority indicator for urgent priority', () => {
    const task = createTask({ priority: 'urgent' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })

  it('should render priority indicator for medium priority', () => {
    const task = createTask({ priority: 'medium' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText('Medium')).toBeInTheDocument()
  })

  it('should not render priority indicator for no priority', () => {
    const task = createTask({ priority: 'none' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.queryByText('Low')).not.toBeInTheDocument()
    expect(screen.queryByText('Medium')).not.toBeInTheDocument()
    expect(screen.queryByText('High')).not.toBeInTheDocument()
    expect(screen.queryByText('Urgent')).not.toBeInTheDocument()
  })

  it('should render due date when set', () => {
    const task = createTask({ dueDate: new Date('2026-01-15') })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText(/jan 15/i)).toBeInTheDocument()
  })

  it('should not render due date when not set', () => {
    const task = createTask({ dueDate: null })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.queryByText(/jan/i)).not.toBeInTheDocument()
  })

  it('should show repeat icon for repeating tasks', () => {
    const task = createTask({
      isRepeating: true,
      repeatConfig: {
        frequency: 'daily',
        interval: 1,
        endType: 'never',
        completedCount: 0,
        createdAt: new Date()
      }
    })
    render(<KanbanCard {...defaultProps} task={task} />)

    // Check for the aria-label on the repeat icon
    expect(screen.getByLabelText('Repeating task')).toBeInTheDocument()
  })

  it('should show completed styling when isCompleted is true', () => {
    render(<KanbanCard {...defaultProps} isCompleted />)

    // Check for the completed checkmark icon
    expect(screen.getByLabelText('Completed')).toBeInTheDocument()
  })

  it('should call onClick when card is clicked', async () => {
    const user = userEvent.setup()
    render(<KanbanCard {...defaultProps} />)

    const card = screen.getByRole('option')
    await user.click(card)

    expect(defaultProps.onClick).toHaveBeenCalled()
  })

  it('should call onDoubleClick when card is double-clicked', async () => {
    const user = userEvent.setup()
    render(<KanbanCard {...defaultProps} />)

    const card = screen.getByRole('option')
    await user.dblClick(card)

    expect(defaultProps.onDoubleClick).toHaveBeenCalled()
  })

  it('should have proper aria-label with task title', () => {
    render(<KanbanCard {...defaultProps} />)

    expect(screen.getByRole('option', { name: 'Task: Test Task' })).toBeInTheDocument()
  })
})

// ============================================================================
// T516: KanbanCard - Selection Mode Tests
// ============================================================================

describe('T516: KanbanCard - selection mode', () => {
  const defaultProps = {
    task: createTask(),
    columnId: 'column-1',
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onToggleSelect: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should show selection checkbox in selection mode', () => {
    render(<KanbanCard {...defaultProps} isSelectionMode onToggleSelect={vi.fn()} />)

    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('should not show selection checkbox when not in selection mode', () => {
    render(<KanbanCard {...defaultProps} isSelectionMode={false} />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('should show checked checkbox when isCheckedForSelection is true', () => {
    render(
      <KanbanCard
        {...defaultProps}
        isSelectionMode
        isCheckedForSelection
        onToggleSelect={vi.fn()}
      />
    )

    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('should call onToggleSelect when clicking in selection mode', async () => {
    const onToggleSelect = vi.fn()
    const user = userEvent.setup()
    render(<KanbanCard {...defaultProps} isSelectionMode onToggleSelect={onToggleSelect} />)

    const card = screen.getByRole('option')
    await user.click(card)

    expect(onToggleSelect).toHaveBeenCalledWith('task-1')
  })

  it('should toggle selection on Cmd/Ctrl+click', async () => {
    const onToggleSelect = vi.fn()
    const user = userEvent.setup()
    render(<KanbanCard {...defaultProps} onToggleSelect={onToggleSelect} />)

    const card = screen.getByRole('option')
    await user.keyboard('{Meta>}')
    await user.click(card)
    await user.keyboard('{/Meta}')

    expect(onToggleSelect).toHaveBeenCalledWith('task-1')
  })
})

// ============================================================================
// KanbanCard - Focus and State Tests
// ============================================================================

describe('KanbanCard - focus and state', () => {
  const defaultProps = {
    task: createTask(),
    columnId: 'column-1',
    onClick: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should have tabIndex 0 when focused', () => {
    render(<KanbanCard {...defaultProps} isFocused />)

    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('tabindex', '0')
  })

  it('should have tabIndex -1 when not focused', () => {
    render(<KanbanCard {...defaultProps} isFocused={false} />)

    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('tabindex', '-1')
  })

  it('should have aria-selected true when focused', () => {
    render(<KanbanCard {...defaultProps} isFocused />)

    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('aria-selected', 'true')
  })

  it('should have aria-selected true when selected', () => {
    render(<KanbanCard {...defaultProps} isSelected />)

    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('aria-selected', 'true')
  })

  it('should trigger onClick on Space key press', async () => {
    const user = userEvent.setup()
    render(<KanbanCard {...defaultProps} isFocused />)

    const card = screen.getByRole('option')
    card.focus()
    await user.keyboard(' ')

    expect(defaultProps.onClick).toHaveBeenCalled()
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('KanbanCard - accessibility', () => {
  const defaultProps = {
    task: createTask(),
    columnId: 'column-1',
    onClick: vi.fn()
  }

  it('should have option role for sortable item', () => {
    render(<KanbanCard {...defaultProps} />)

    expect(screen.getByRole('option')).toBeInTheDocument()
  })

  it('should have proper aria-label with task title', () => {
    render(<KanbanCard {...defaultProps} />)

    expect(screen.getByRole('option', { name: 'Task: Test Task' })).toBeInTheDocument()
  })

  it('should announce priority to screen readers', () => {
    const task = createTask({ priority: 'high' })
    render(<KanbanCard {...defaultProps} task={task} />)

    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('should have aria-label on selection checkbox', () => {
    const task = createTask({ title: 'My Task' })
    render(<KanbanCard {...defaultProps} task={task} isSelectionMode onToggleSelect={vi.fn()} />)

    expect(screen.getByRole('checkbox', { name: /select my task/i })).toBeInTheDocument()
  })
})
