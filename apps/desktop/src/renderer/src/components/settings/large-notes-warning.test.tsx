import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import type { LargeNotesResult } from '@memry/contracts/ipc-sync-ops'
import { LargeNotesWarning } from './large-notes-warning'

const getLargeNotes = vi.fn<() => Promise<LargeNotesResult>>()

beforeEach(() => {
  vi.clearAllMocks()
  const api = window.api as typeof window.api & {
    syncOps?: { getLargeNotes?: typeof getLargeNotes }
  }
  api.syncOps = api.syncOps ?? {}
  api.syncOps.getLargeNotes = getLargeNotes
})

describe('LargeNotesWarning', () => {
  it('#given no large notes #then it renders nothing', async () => {
    getLargeNotes.mockResolvedValue({ maxBytes: 3_826_189, notes: [] })

    const { container } = renderWithProviders(<LargeNotesWarning />)

    await waitFor(() => expect(getLargeNotes).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('#given a note already over the ceiling #then it names the note and says it is not syncing', async () => {
    getLargeNotes.mockResolvedValue({
      maxBytes: 3_826_189,
      notes: [
        {
          id: 'note-big',
          title: 'Server log dump',
          path: 'logs/server.md',
          sizeBytes: 4_000_000,
          status: 'over'
        }
      ]
    })

    renderWithProviders(<LargeNotesWarning />)

    expect(await screen.findByText('Server log dump')).toBeInTheDocument()
    expect(screen.getByText('Not syncing')).toBeInTheDocument()
  })

  it('#given a note still under the ceiling #then it warns while the note still syncs', async () => {
    getLargeNotes.mockResolvedValue({
      maxBytes: 3_826_189,
      notes: [
        {
          id: 'note-growing',
          title: 'Meeting log',
          path: 'Meeting log.md',
          sizeBytes: 3_200_000,
          status: 'approaching'
        }
      ]
    })

    renderWithProviders(<LargeNotesWarning />)

    expect(await screen.findByText('Meeting log')).toBeInTheDocument()
    expect(screen.getByText('Approaching the limit')).toBeInTheDocument()
    expect(screen.queryByText('Not syncing')).not.toBeInTheDocument()
  })

  it('#given the lookup fails #then it renders nothing rather than an error', async () => {
    getLargeNotes.mockRejectedValue(new Error('no vault'))

    const { container } = renderWithProviders(<LargeNotesWarning />)

    await waitFor(() => expect(getLargeNotes).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
