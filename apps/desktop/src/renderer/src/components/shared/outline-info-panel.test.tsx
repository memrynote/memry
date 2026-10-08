import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import type { NoteSyncState } from '@memry/contracts/ipc-sync-ops'
import { OutlineInfoPanel } from './outline-info-panel'

const getNoteSyncState = vi.fn<(noteId: string) => Promise<NoteSyncState | null>>()

const stats = {
  wordCount: 12,
  characterCount: 64,
  createdAt: '2026-05-10T00:00:00.000Z',
  modifiedAt: '2026-05-11T00:00:00.000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  const api = window.api as typeof window.api & {
    syncOps?: { getNoteSyncState?: typeof getNoteSyncState }
  }
  api.syncOps = api.syncOps ?? {}
  api.syncOps.getNoteSyncState = getNoteSyncState
  getNoteSyncState.mockResolvedValue({
    state: 'pending',
    waitingSince: Date.now() - 60_000,
    lastSentAt: null,
    bodyConfirmedAt: null,
    lastFailedAt: null,
    lastRejectedAt: null
  })
})

function hoverPanel(container: HTMLElement): void {
  const panel = container.querySelector('.outline-indicator')
  expect(panel).not.toBeNull()
  fireEvent.mouseEnter(panel as Element)
}

describe('OutlineInfoPanel without headings (#2779)', () => {
  it('#given a note with no headings #then hovering the panel shows its sync line', async () => {
    const { container } = renderWithProviders(
      <OutlineInfoPanel headings={[]} stats={stats} noteId="n1" />
    )

    hoverPanel(container)

    expect(await screen.findByText('Waiting since 1 minute ago')).toBeInTheDocument()
    expect(getNoteSyncState).toHaveBeenCalledWith('n1')
    expect(screen.getByText('12 words')).toBeInTheDocument()
  })

  it('#given a note id but no stats yet #then the sync line still shows', async () => {
    const { container } = renderWithProviders(<OutlineInfoPanel headings={[]} noteId="n1" />)

    hoverPanel(container)

    expect(await screen.findByText('Waiting since 1 minute ago')).toBeInTheDocument()
  })

  it('#given no headings, stats or note #then nothing renders', () => {
    const { container } = renderWithProviders(<OutlineInfoPanel headings={[]} />)

    expect(container.querySelector('.outline-indicator')).toBeNull()
  })
})
