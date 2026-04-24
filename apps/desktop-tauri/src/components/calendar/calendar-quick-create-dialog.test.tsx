import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarQuickCreateDialog } from './calendar-quick-create-dialog'

const baseProps = {
  anchorRect: { x: 100, y: 200, width: 300, height: 96 },
  startAt: '2026-04-14T14:00',
  endAt: '2026-04-14T15:30',
  isAllDay: false,
  onSave: vi.fn(),
  onDismiss: vi.fn(),
  onOpenFullEditor: vi.fn()
}

describe('CalendarQuickCreateDialog', () => {
  it('renders with datetime display', () => {
    render(<CalendarQuickCreateDialog {...baseProps} />)
    expect(screen.getByTestId('quick-create-popover')).toBeInTheDocument()
    expect(screen.getByText(/14:00/)).toBeInTheDocument()
    expect(screen.getByText(/15:30/)).toBeInTheDocument()
  })

  it('auto-focuses the title input', () => {
    render(<CalendarQuickCreateDialog {...baseProps} />)
    const input = screen.getByPlaceholderText('New Event')
    expect(input).toHaveFocus()
  })

  it('calls onSave with draft when Enter pressed in title', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Team standup{Enter}')
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].title).toBe('Team standup')
  })

  it('calls onSave when Save button is clicked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<CalendarQuickCreateDialog {...baseProps} onSave={onSave} />)
    await userEvent.type(screen.getByPlaceholderText('New Event'), 'Click save test')
    await userEvent.click(screen.getByTestId('quick-create-save'))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].title).toBe('Click save test')
  })

  it('does not call onSave when title is empty', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not double-submit when Save clicked while submitting', async () => {
    let resolve!: () => void
    const onSave = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    render(<CalendarQuickCreateDialog {...baseProps} onSave={onSave} />)
    await userEvent.type(screen.getByPlaceholderText('New Event'), 'Guarded')
    const saveBtn = screen.getByTestId('quick-create-save')
    await userEvent.click(saveBtn)
    await userEvent.click(saveBtn)
    expect(onSave).toHaveBeenCalledOnce()
    resolve()
  })

  it('calls onDismiss on Escape', async () => {
    const onDismiss = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('calls onDismiss when Cancel is clicked', async () => {
    const onDismiss = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('surfaces an error message when onSave rejects and keeps the dialog open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('DB write failed'))
    const onDismiss = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onSave={onSave} onDismiss={onDismiss} />)
    await userEvent.type(screen.getByPlaceholderText('New Event'), 'Will fail')
    await userEvent.click(screen.getByTestId('quick-create-save'))
    expect(await screen.findByTestId('quick-create-error')).toHaveTextContent(/DB write failed/)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('calls onOpenFullEditor with current draft when "Add details" clicked', async () => {
    const onOpenFullEditor = vi.fn()
    render(<CalendarQuickCreateDialog {...baseProps} onOpenFullEditor={onOpenFullEditor} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Design review')
    await userEvent.click(screen.getByText('Add details'))
    expect(onOpenFullEditor).toHaveBeenCalledOnce()
    expect(onOpenFullEditor.mock.calls[0][0].title).toBe('Design review')
  })

  it('displays all-day format when isAllDay is true', () => {
    render(
      <CalendarQuickCreateDialog
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
