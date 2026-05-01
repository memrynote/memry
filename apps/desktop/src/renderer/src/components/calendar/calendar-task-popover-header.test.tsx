import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'
import type { Status } from '@/data/tasks-data'

const baseTask = {
  id: 't1',
  title: 'Review Q2 roadmap',
  completedAt: null,
  parentId: null,
  statusId: 'todo'
}
const statuses: Status[] = [
  { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
  { id: 'progress', name: 'In Progress', color: '#3b82f6', type: 'in_progress', order: 1 },
  { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 2 }
]

describe('CalendarTaskPopoverHeader', () => {
  it('renders title', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} statuses={statuses} />)
    expect(screen.getByText('Review Q2 roadmap')).toBeInTheDocument()
  })

  it('hides parent breadcrumb when no parent', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} statuses={statuses} />)
    expect(screen.queryByTestId('parent-breadcrumb')).not.toBeInTheDocument()
  })

  it('renders parent breadcrumb when parent provided', () => {
    render(
      <CalendarTaskPopoverHeader
        task={{ ...baseTask, parentId: 'p' }}
        parentTitle="Q2 Planning"
        statuses={statuses}
      />
    )
    expect(screen.getByTestId('parent-breadcrumb')).toHaveTextContent('Q2 Planning')
  })

  it('shows strikethrough when completed', () => {
    render(
      <CalendarTaskPopoverHeader
        task={{ ...baseTask, completedAt: '2026-04-28T10:00:00Z' }}
        parentTitle={null}
        statuses={statuses}
      />
    )
    expect(screen.getByText('Review Q2 roadmap')).toHaveClass('line-through')
  })

  it('renders task status as a read-only icon', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} statuses={statuses} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /status: to do/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /status/i })).not.toBeInTheDocument()
    expect(screen.queryByText('To Do')).not.toBeInTheDocument()
  })

  it('does not open a status dropdown when the status icon is clicked', async () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} statuses={statuses} />)
    await userEvent.click(screen.getByRole('img', { name: /status: to do/i }))
    expect(screen.queryByRole('option', { name: /in progress/i })).not.toBeInTheDocument()
  })

  it('does not render the overflow action trigger', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} statuses={statuses} />)
    expect(screen.queryByLabelText(/more actions/i)).not.toBeInTheDocument()
  })
})
