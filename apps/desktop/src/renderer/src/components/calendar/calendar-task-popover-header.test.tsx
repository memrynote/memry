import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'

const baseTask = {
  id: 't1',
  title: 'Review Q2 roadmap',
  completedAt: null,
  parentId: null
}

describe('CalendarTaskPopoverHeader', () => {
  it('renders title', () => {
    render(
      <CalendarTaskPopoverHeader
        task={baseTask}
        parentTitle={null}
        onToggleComplete={vi.fn()}
        onOverflow={vi.fn()}
      />
    )
    expect(screen.getByText('Review Q2 roadmap')).toBeInTheDocument()
  })

  it('hides parent breadcrumb when no parent', () => {
    render(
      <CalendarTaskPopoverHeader
        task={baseTask}
        parentTitle={null}
        onToggleComplete={vi.fn()}
        onOverflow={vi.fn()}
      />
    )
    expect(screen.queryByTestId('parent-breadcrumb')).not.toBeInTheDocument()
  })

  it('renders parent breadcrumb when parent provided', () => {
    render(
      <CalendarTaskPopoverHeader
        task={{ ...baseTask, parentId: 'p' }}
        parentTitle="Q2 Planning"
        onToggleComplete={vi.fn()}
        onOverflow={vi.fn()}
      />
    )
    expect(screen.getByTestId('parent-breadcrumb')).toHaveTextContent('Q2 Planning')
  })

  it('shows strikethrough when completed', () => {
    render(
      <CalendarTaskPopoverHeader
        task={{ ...baseTask, completedAt: '2026-04-28T10:00:00Z' }}
        parentTitle={null}
        onToggleComplete={vi.fn()}
        onOverflow={vi.fn()}
      />
    )
    expect(screen.getByText('Review Q2 roadmap')).toHaveClass('line-through')
  })

  it('checkbox click calls onToggleComplete', async () => {
    const onToggle = vi.fn()
    render(
      <CalendarTaskPopoverHeader
        task={baseTask}
        parentTitle={null}
        onToggleComplete={onToggle}
        onOverflow={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('overflow click calls onOverflow', async () => {
    const onOverflow = vi.fn()
    render(
      <CalendarTaskPopoverHeader
        task={baseTask}
        parentTitle={null}
        onToggleComplete={vi.fn()}
        onOverflow={onOverflow}
      />
    )
    await userEvent.click(screen.getByLabelText(/more actions/i))
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })
})
