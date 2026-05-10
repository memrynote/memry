import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniProgressBar } from './mini-progress-bar'
import { SubtaskBadge } from './subtask-badge'
import { SubtaskProgressBar } from './subtask-progress-bar'
import { TodayEmptyState } from './today-empty-state'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

describe('task small components', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders compact and full subtask progress states', () => {
    const progress = { total: 4, completed: 2, percentage: 50 }
    const done = { total: 4, completed: 4, percentage: 100 }

    const { rerender, container } = render(<MiniProgressBar progress={{ ...progress, total: 0 }} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<MiniProgressBar progress={progress} />)
    expect(screen.getByRole('progressbar', { name: '2 of 4 subtasks completed' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    )

    rerender(<SubtaskProgressBar progress={done} size="md" />)
    expect(screen.getByText('4/4')).toBeInTheDocument()

    rerender(<SubtaskProgressBar progress={progress} showLabel={false} />)
    expect(screen.queryByText('2/4')).not.toBeInTheDocument()
  })

  it('handles subtask badge mouse and keyboard activation', () => {
    const onClick = vi.fn()
    const { rerender, container } = render(<SubtaskBadge completed={0} total={0} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<SubtaskBadge completed={1} total={3} onClick={onClick} />)
    const badge = screen.getByRole('button', { name: '1 of 3 subtasks complete' })
    fireEvent.click(badge)
    fireEvent.keyDown(badge, { key: 'Enter' })
    fireEvent.keyDown(badge, { key: ' ' })
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('renders today empty-state variants and add actions', () => {
    const onAddTask = vi.fn()
    const { rerender } = render(<TodayEmptyState hasOverdue onAddTask={onAddTask} />)
    expect(
      screen.getByText('phaseF.componentsTasksTodayEmptyState.nothingScheduledForToday')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('phaseF.componentsTasksTodayEmptyState.addTaskForToday'))
    expect(onAddTask).toHaveBeenCalled()

    rerender(<TodayEmptyState hasOverdue={false} onAddTask={onAddTask} />)
    expect(
      screen.getByText('phaseF.componentsTasksTodayEmptyState.allCaughtUpForToday')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('phaseF.componentsTasksTodayEmptyState.addTaskForToday2'))
    expect(onAddTask).toHaveBeenCalledTimes(2)
  })
})
