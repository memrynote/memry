import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'

const subtasks = [
  { id: 's1', title: 'Pull metrics', completedAt: '2026-04-28T10:00:00Z' },
  { id: 's2', title: 'Send pre-read', completedAt: '2026-04-28T11:00:00Z' },
  { id: 's3', title: 'Draft priorities', completedAt: null },
  { id: 's4', title: 'Schedule follow-up', completedAt: null }
]

describe('CalendarTaskPopoverSubtasks', () => {
  it('renders nothing when subtasks empty', () => {
    const { container } = render(
      <CalendarTaskPopoverSubtasks subtasks={[]} onToggleSubtask={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows done progress as a bar and a count', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByRole('progressbar', { name: '2 of 4 done' })).toHaveAttribute(
      'aria-valuenow',
      '2'
    )
    expect(screen.getByText('2 / 4')).toBeInTheDocument()
  })

  it('renders all subtask titles', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('Pull metrics')).toBeInTheDocument()
    expect(screen.getByText('Schedule follow-up')).toBeInTheDocument()
  })

  it('strikes through completed subtasks', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('Pull metrics')).toHaveClass('line-through')
    expect(screen.getByText('Draft priorities')).not.toHaveClass('line-through')
  })

  it('toggles subtask via onToggleSubtask callback', async () => {
    const onToggle = vi.fn()
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={onToggle} />)
    const checkboxes = screen.getAllByRole('checkbox')
    await userEvent.click(checkboxes[2])
    expect(onToggle).toHaveBeenCalledWith('s3')
  })
})
