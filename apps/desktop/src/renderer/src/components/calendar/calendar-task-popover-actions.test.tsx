import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverActions } from './calendar-task-popover-actions'

const baseProps = {
  isCompleted: false,
  isAllDay: false,
  sourceNoteId: null as string | null,
  onOpenTask: vi.fn(),
  onOpenSourceNote: vi.fn(),
  onSnooze: vi.fn(),
  onRemoveDueDate: vi.fn(),
  onPickDateTime: vi.fn(),
  now: new Date('2026-04-29T12:00:00')
}

describe('CalendarTaskPopoverActions', () => {
  it('renders Open task and Reschedule when not completed', () => {
    render(<CalendarTaskPopoverActions {...baseProps} />)
    expect(screen.getByRole('button', { name: /open task/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reschedule/i })).toBeInTheDocument()
  })

  it('hides Source note button when sourceNoteId is null', () => {
    render(<CalendarTaskPopoverActions {...baseProps} />)
    expect(screen.queryByRole('button', { name: /source note/i })).not.toBeInTheDocument()
  })

  it('shows Source note button when sourceNoteId is set', () => {
    render(<CalendarTaskPopoverActions {...baseProps} sourceNoteId="n1" />)
    expect(screen.getByRole('button', { name: /source note/i })).toBeInTheDocument()
  })

  it('hides Reschedule when completed', () => {
    render(<CalendarTaskPopoverActions {...baseProps} isCompleted={true} />)
    expect(screen.queryByRole('button', { name: /reschedule/i })).not.toBeInTheDocument()
  })

  it('opens reschedule submenu and calls onSnooze with target', async () => {
    const props = { ...baseProps, onSnooze: vi.fn() }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    await userEvent.click(screen.getByText(/Tomorrow/))
    expect(props.onSnooze).toHaveBeenCalledWith({ dueDate: '2026-04-30', dueTime: '09:00' })
  })

  it('hides Later today after 19:00', async () => {
    const props = { ...baseProps, now: new Date('2026-04-29T20:00:00') }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    expect(screen.queryByText(/Later today/)).not.toBeInTheDocument()
  })

  it('Open task click calls onOpenTask', async () => {
    const props = { ...baseProps, onOpenTask: vi.fn() }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(props.onOpenTask).toHaveBeenCalled()
  })
})
