import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import type { NoteSyncState } from '@memry/contracts/ipc-sync-ops'
import { NoteSyncLine } from './note-sync-line'

const getNoteSyncState = vi.fn<(noteId: string) => Promise<NoteSyncState | null>>()

const base: NoteSyncState = {
  state: 'confirmed',
  waitingSince: null,
  lastSentAt: null,
  bodyConfirmedAt: null,
  lastFailedAt: null,
  lastRejectedAt: null
}

beforeEach(() => {
  vi.clearAllMocks()
  const api = window.api as typeof window.api & {
    syncOps?: { getNoteSyncState?: typeof getNoteSyncState }
  }
  api.syncOps = api.syncOps ?? {}
  api.syncOps.getNoteSyncState = getNoteSyncState
})

describe('NoteSyncLine (#2647)', () => {
  it('#given a confirmed body #then it says when the server stored it', async () => {
    getNoteSyncState.mockResolvedValue({ ...base, bodyConfirmedAt: Date.now() - 120_000 })

    renderWithProviders(<NoteSyncLine noteId="n1" />)

    expect(await screen.findByText('On the server 2 minutes ago')).toBeInTheDocument()
    expect(getNoteSyncState).toHaveBeenCalledWith('n1')
  })

  it('#given changes waiting #then it says so instead of synced', async () => {
    getNoteSyncState.mockResolvedValue({
      ...base,
      state: 'pending',
      waitingSince: Date.now() - 60_000,
      bodyConfirmedAt: Date.now() - 3_600_000
    })

    renderWithProviders(<NoteSyncLine noteId="n1" />)

    expect(await screen.findByText('Waiting since 1 minute ago')).toBeInTheDocument()
  })

  it('#given a refused push #then it names the refusal', async () => {
    getNoteSyncState.mockResolvedValue({ ...base, state: 'rejected', lastRejectedAt: Date.now() })

    renderWithProviders(<NoteSyncLine noteId="n1" />)

    expect(await screen.findByText('The server refused the last change')).toBeInTheDocument()
  })
})
