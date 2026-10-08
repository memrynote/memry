import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import type { UnsentNotesResult } from '@memry/contracts/ipc-sync-ops'
import { UnsentNotesList } from './unsent-notes-list'

const getUnsentNotes = vi.fn<() => Promise<UnsentNotesResult>>()

beforeEach(() => {
  vi.clearAllMocks()
  const api = window.api as typeof window.api & {
    syncOps?: { getUnsentNotes?: typeof getUnsentNotes }
  }
  api.syncOps = api.syncOps ?? {}
  api.syncOps.getUnsentNotes = getUnsentNotes
})

describe('UnsentNotesList (#2647)', () => {
  it('#given nothing unsent #then it renders nothing', async () => {
    getUnsentNotes.mockResolvedValue({ total: 0, notes: [] })

    const { container } = renderWithProviders(<UnsentNotesList />)

    await waitFor(() => expect(getUnsentNotes).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('#given unsent notes #then it counts them and names each with why', async () => {
    getUnsentNotes.mockResolvedValue({
      total: 3,
      notes: [
        {
          id: 'a',
          title: 'Refused note',
          path: 'a.md',
          state: 'rejected',
          waitingSince: null,
          reasons: ['rejected']
        },
        {
          id: 'b',
          title: 'Edited offline',
          path: 'b.md',
          state: 'pending',
          waitingSince: Date.now() - 60_000,
          reasons: ['body', 'file_not_taken']
        }
      ]
    })

    renderWithProviders(<UnsentNotesList />)

    expect(await screen.findByText('Notes with unsent changes')).toBeInTheDocument()
    expect(screen.getByText('3 notes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('Refused note')).toBeInTheDocument()
    expect(screen.getByText('Refused by the server')).toBeInTheDocument()
    expect(screen.getByText('Text · File not merged yet')).toBeInTheDocument()
    expect(screen.getByText('And 1 more note')).toBeInTheDocument()
  })
})
