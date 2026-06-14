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
    expect(onOpenNote).toHaveBeenCalledWith('n1', null)

    // clicks inside the popover never dismiss
    fireEvent.pointerDown(screen.getByTestId('calendar-note-popover'))
    expect(onDismiss).not.toHaveBeenCalled()

    // outside click + Escape dismiss
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('shows a note_date reminder with its own kind label and opens at the pill anchor', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    const onDismiss = vi.fn()

    render(
      <CalendarNotePopover
        item={
          {
            sourceType: 'note_date',
            visualType: 'note_date',
            sourceId: 'rem-nd-1',
            noteId: 'note-7',
            anchorId: 'anchor-1',
            title: 'Launch Plan',
            descriptionPreview: null,
            isAllDay: false,
            startAt: '2026-04-14T11:00:00.000Z'
          } as never
        }
        anchorRect={{ x: 20, y: 30, width: 40, height: 50 }}
        onOpenNote={onOpenNote}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByText('Launch Plan')).toBeInTheDocument()
    // distinct kind label for the inline-pill reminder
    expect(screen.getByText('notePopover.kindDateReminder')).toBeInTheDocument()

    // opens the note scrolled to the exact pill (noteId + anchorId)
    await user.click(screen.getByRole('button', { name: 'notePopover.open' }))
    expect(onOpenNote).toHaveBeenCalledWith('note-7', 'anchor-1')
  })
})
