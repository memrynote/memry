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

  it('shows X of Y done counter', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('2 of 4 done')).toBeInTheDocument()
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
