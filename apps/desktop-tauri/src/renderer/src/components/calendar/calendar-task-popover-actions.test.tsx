import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CalendarTaskPopoverActionBar,
  CalendarTaskPopoverMenu,
  CalendarTaskPopoverMoveRow
} from './calendar-task-popover-actions'

const NOON = new Date('2026-04-29T12:00:00')

describe('CalendarTaskPopoverMoveRow', () => {
  it('reschedules in one click, without a date picker', async () => {
    const onSnooze = vi.fn()
    render(<CalendarTaskPopoverMoveRow isAllDay={false} onSnooze={onSnooze} now={NOON} />)

    await userEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    expect(onSnooze).toHaveBeenCalledWith({ dueDate: '2026-04-30', dueTime: '09:00' })

    await userEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(onSnooze).toHaveBeenLastCalledWith({ dueDate: '2026-05-04', dueTime: '09:00' })

    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onSnooze).toHaveBeenCalledTimes(3)
  })

  it('drops Later after 19:00 and for all-day tasks', () => {
    const { rerender } = render(
      <CalendarTaskPopoverMoveRow
        isAllDay={false}
        onSnooze={vi.fn()}
        now={new Date('2026-04-29T19:30:00')}
      />
    )
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument()

    rerender(<CalendarTaskPopoverMoveRow isAllDay onSnooze={vi.fn()} now={NOON} />)
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeInTheDocument()
  })
})

describe('CalendarTaskPopoverMenu', () => {
  const baseProps = {
    isCompleted: false,
    sourceNoteId: null as string | null,
    onOpenSourceNote: vi.fn(),
    onPickDateTime: vi.fn(),
    onRemoveDueDate: vi.fn()
  }

  it('holds date editing and hides the source note without one', async () => {
    const onRemoveDueDate = vi.fn()
    render(<CalendarTaskPopoverMenu {...baseProps} onRemoveDueDate={onRemoveDueDate} />)

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    expect(screen.queryByRole('menuitem', { name: /source note/i })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /pick date/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /remove due date/i }))
    expect(onRemoveDueDate).toHaveBeenCalled()
  })

  it('offers the source note when there is one', async () => {
    const onOpenSourceNote = vi.fn()
    render(
      <CalendarTaskPopoverMenu
        {...baseProps}
        sourceNoteId="note-1"
        onOpenSourceNote={onOpenSourceNote}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /source note/i }))
    expect(onOpenSourceNote).toHaveBeenCalled()
  })

  it('drops date editing once the task is done', async () => {
    render(<CalendarTaskPopoverMenu {...baseProps} isCompleted sourceNoteId="note-1" />)

    await userEvent.click(screen.getByRole('button', { name: /more actions/i }))
    expect(screen.queryByRole('menuitem', { name: /pick date/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /remove due date/i })).not.toBeInTheDocument()
  })
})

describe('CalendarTaskPopoverActionBar', () => {
  it('completes on the start and opens on the end, showing the keys', async () => {
    const onToggleComplete = vi.fn()
    const onOpenTask = vi.fn()
    render(
      <CalendarTaskPopoverActionBar
        isCompleted={false}
        onToggleComplete={onToggleComplete}
        onOpenTask={onOpenTask}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /complete/i }))
    expect(onToggleComplete).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /^open/i }))
    expect(onOpenTask).toHaveBeenCalled()
    expect(screen.getAllByText('↵')).toHaveLength(2)
  })

  it('reopens a completed task', () => {
    render(
      <CalendarTaskPopoverActionBar isCompleted onToggleComplete={vi.fn()} onOpenTask={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /mark not done/i })).toBeInTheDocument()
  })
})
