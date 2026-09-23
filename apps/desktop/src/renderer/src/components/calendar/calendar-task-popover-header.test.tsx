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

const baseProps = {
  task: baseTask,
  parentTitle: null,
  projectName: 'memrynote',
  onToggleComplete: vi.fn(),
  onOpenTask: vi.fn()
}

describe('CalendarTaskPopoverHeader', () => {
  it('renders the title under a Task · project label', () => {
    render(<CalendarTaskPopoverHeader {...baseProps} />)
    expect(screen.getByText('Review Q2 roadmap')).toBeInTheDocument()
    expect(screen.getByText('Task · memrynote')).toBeInTheDocument()
  })

  it('hides parent breadcrumb when no parent', () => {
    render(<CalendarTaskPopoverHeader {...baseProps} />)
    expect(screen.queryByTestId('parent-breadcrumb')).not.toBeInTheDocument()
  })

  it('renders parent breadcrumb when parent provided', () => {
    render(
      <CalendarTaskPopoverHeader
        {...baseProps}
        task={{ ...baseTask, parentId: 'p' }}
        parentTitle="Q2 Planning"
      />
    )
    expect(screen.getByTestId('parent-breadcrumb')).toHaveTextContent('Q2 Planning')
  })

  it('shows strikethrough and a checked box when completed', () => {
    render(
      <CalendarTaskPopoverHeader
        {...baseProps}
        task={{ ...baseTask, completedAt: '2026-04-28T10:00:00Z' }}
      />
    )
    expect(screen.getByText('Review Q2 roadmap')).toHaveClass('line-through')
    expect(screen.getByRole('checkbox', { name: /mark not done/i })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('completes the task from its checkbox in one click', async () => {
    const onToggleComplete = vi.fn()
    render(<CalendarTaskPopoverHeader {...baseProps} onToggleComplete={onToggleComplete} />)
    await userEvent.click(screen.getByRole('checkbox', { name: /mark done/i }))
    expect(onToggleComplete).toHaveBeenCalled()
  })

  it('opens the task from the header and renders the overflow slot', async () => {
    const onOpenTask = vi.fn()
    render(
      <CalendarTaskPopoverHeader
        {...baseProps}
        onOpenTask={onOpenTask}
        menu={<button type="button">menu slot</button>}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(onOpenTask).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'menu slot' })).toBeInTheDocument()
  })
})
