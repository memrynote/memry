import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'
import type { Tag } from '@/components/note/tags-row'

const NOW = new Date('2026-04-29T10:00:00')

const baseProps = {
  task: {
    dueDate: '2026-04-30',
    dueTime: '14:00',
    projectId: 'p1',
    priority: 0 as 0 | 1 | 2 | 3 | 4
  },
  projectName: 'Memry',
  tags: [] as Tag[],
  repeatSummary: null,
  description: null,
  now: NOW,
  isCompleted: false
}

describe('CalendarTaskPopoverMeta', () => {
  it('renders due row + project always', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.getByText(/Tomorrow/)).toBeInTheDocument()
    expect(screen.getByText('Memry')).toBeInTheDocument()
  })

  it('hides recurrence when no summary', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('recurrence-row')).not.toBeInTheDocument()
  })

  it('shows recurrence when provided', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} repeatSummary="Repeats weekly" />)
    expect(screen.getByTestId('recurrence-row')).toHaveTextContent('Repeats weekly')
  })

  it('hides priority when 0', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('priority-row')).not.toBeInTheDocument()
  })

  it('renders priority when > 0', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} task={{ ...baseProps.task, priority: 2 }} />)
    expect(screen.getByTestId('priority-row')).toBeInTheDocument()
  })

  it('renders up to 3 tags then +N', () => {
    const tags: Tag[] = [
      { id: 'a', name: 'a', color: 'rose' },
      { id: 'b', name: 'b', color: 'sky' },
      { id: 'c', name: 'c', color: 'sage' },
      { id: 'd', name: 'd', color: 'stone' },
      { id: 'e', name: 'e', color: 'amber' }
    ]

    render(<CalendarTaskPopoverMeta {...baseProps} tags={tags} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.getByText('c')).toBeInTheDocument()
    expect(screen.queryByText('d')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('renders tags as colored tag chips', () => {
    render(
      <CalendarTaskPopoverMeta
        {...baseProps}
        tags={[{ id: 'focus', name: 'focus', color: 'rose' }]}
      />
    )
    expect(screen.getByText('focus')).toHaveStyle({ color: '#E07888' })
  })

  it('hides description when empty', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('description')).not.toBeInTheDocument()
  })

  it('renders description with line clamp class', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} description="Some long text" />)
    expect(screen.getByTestId('description')).toHaveClass('line-clamp-3')
  })

  it('marks overdue with destructive style when past + not completed', () => {
    const props = {
      ...baseProps,
      task: { ...baseProps.task, dueDate: '2026-04-27' }
    }
    render(<CalendarTaskPopoverMeta {...props} />)
    expect(screen.getByTestId('due-row')).toHaveClass('text-destructive')
  })
})
