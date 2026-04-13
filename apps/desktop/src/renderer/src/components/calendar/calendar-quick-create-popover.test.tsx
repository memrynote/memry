import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'

const baseProps = {
  anchorRect: { x: 100, y: 200, width: 300, height: 96 },
  startAt: '2026-04-14T14:00',
  endAt: '2026-04-14T15:30',
  isAllDay: false,
  onSave: vi.fn(),
  onDismiss: vi.fn(),
  onOpenFullEditor: vi.fn()
}

describe('CalendarQuickCreatePopover', () => {
  it('renders with datetime display', () => {
    render(<CalendarQuickCreatePopover {...baseProps} />)
    expect(screen.getByTestId('quick-create-popover')).toBeInTheDocument()
    expect(screen.getByText(/14:00/)).toBeInTheDocument()
    expect(screen.getByText(/15:30/)).toBeInTheDocument()
  })

  it('auto-focuses the title input', () => {
    render(<CalendarQuickCreatePopover {...baseProps} />)
    const input = screen.getByPlaceholderText('New Event')
    expect(input).toHaveFocus()
  })

  it('calls onSave with draft when Enter pressed in title', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Team standup{Enter}')
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].title).toBe('Team standup')
  })

  it('does not call onSave when title is empty', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('calls onDismiss on Escape', async () => {
    const onDismiss = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('calls onOpenFullEditor with current draft when "Add details" clicked', async () => {
    const onOpenFullEditor = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onOpenFullEditor={onOpenFullEditor} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Design review')
    await userEvent.click(screen.getByText('Add details'))
    expect(onOpenFullEditor).toHaveBeenCalledOnce()
    expect(onOpenFullEditor.mock.calls[0][0].title).toBe('Design review')
  })

  it('displays all-day format when isAllDay is true', () => {
    render(
      <CalendarQuickCreatePopover
        {...baseProps}
        isAllDay={true}
        startAt="2026-04-14"
        endAt="2026-04-16"
      />
    )
    expect(screen.getByText(/Apr 14/)).toBeInTheDocument()
    expect(screen.getByText(/Apr 16/)).toBeInTheDocument()
  })
})
