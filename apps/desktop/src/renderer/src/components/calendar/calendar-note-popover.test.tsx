import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarNotePopover } from './calendar-note-popover'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

describe('CalendarNotePopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the note with its property + date and opens the note', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    const onDismiss = vi.fn()

    render(
      <CalendarNotePopover
        item={
          {
            sourceType: 'note',
            sourceId: 'n1',
            title: 'Q3 Launch',
            descriptionPreview: 'Deadline',
            startAt: '2026-06-20T12:00:00.000Z'
          } as never
        }
        anchorRect={{ x: 20, y: 30, width: 40, height: 50 }}
        onOpenNote={onOpenNote}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByText('Q3 Launch')).toBeInTheDocument()
    // descriptionPreview carries the property name; the date label follows it.
    expect(screen.getByText(/Deadline ·/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'notePopover.open' }))
    expect(onOpenNote).toHaveBeenCalledWith('n1')

    // clicks inside the popover never dismiss
    fireEvent.pointerDown(screen.getByTestId('calendar-note-popover'))
    expect(onDismiss).not.toHaveBeenCalled()

    // outside click + Escape dismiss
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })
})
