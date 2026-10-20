import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'

const baseTask = {
  id: 't1',
  title: 'Review Q2 roadmap',
  completedAt: null,
  projectId: 'p1',
  statusId: 's1',
  parentId: null
}

const baseProps = {
  task: baseTask,
  parentTitle: null,
  projectName: 'memrynote',
  onOpenTask: vi.fn(),
  onOpenParent: vi.fn()
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

  it('opens the parent branch from the breadcrumb', async () => {
    const onOpenParent = vi.fn()
    render(
      <CalendarTaskPopoverHeader
        {...baseProps}
        task={{ ...baseTask, parentId: 'p' }}
        parentTitle="Q2 Planning"
        onOpenParent={onOpenParent}
      />
    )
    await userEvent.click(screen.getByTestId('parent-breadcrumb'))
    expect(onOpenParent).toHaveBeenCalled()
  })

  it('shows strikethrough when completed', () => {
    render(
      <CalendarTaskPopoverHeader
        {...baseProps}
        task={{ ...baseTask, completedAt: '2026-04-28T10:00:00Z' }}
      />
    )
    expect(screen.getByText('Review Q2 roadmap')).toHaveClass('line-through')
  })

  it('shows the task status in place of a checkbox', () => {
    render(<CalendarTaskPopoverHeader {...baseProps} />)
    expect(screen.getByTestId('task-popover-status')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
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
