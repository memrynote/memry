import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  openSidebarItem: vi.fn(),
  noteUpdated: null as null | (() => void)
}))

vi.mock('./portal-api', () => ({ searchPortalBlocks: mocks.search }))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/services/notes-service', () => ({
  onNoteCreated: () => () => {},
  onNoteDeleted: () => () => {},
  onNoteRenamed: () => () => {},
  onNoteMoved: () => () => {},
  onNoteUpdated: (callback: () => void) => {
    mocks.noteUpdated = callback
    return () => {}
  }
}))

import { PortalSearchView, searchQueryLabel } from './portal-search-view'

const target = { kind: 'search' as const, text: 'exam', tag: 'bio', limit: 50 }
const definition = { v: 1 as const, target, raw: {} }
const editor = {
  isEditable: true,
  getBlock: () => undefined,
  updateBlock: () => {},
  removeBlocks: () => {}
}

function item(blockId: string, text: string) {
  return {
    noteId: 'n1',
    title: 'Cell Biology',
    path: 'Cell Biology.md',
    blockId,
    anchor: null,
    text,
    parentText: null
  }
}

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PortalSearchView blockId="p" editor={editor} definition={definition} target={target} />
    </QueryClientProvider>
  )
}

describe('PortalSearchView', () => {
  beforeEach(() => {
    mocks.search.mockReset()
    mocks.openSidebarItem.mockReset()
  })

  it('shows the query, the count and each block under its source, anchors hidden', async () => {
    mocks.search.mockResolvedValue({
      results: [item('b1', 'Review chloroplasts ^abcd1'), item('b2', 'Stroma')],
      truncated: false
    })

    renderView()

    expect(await screen.findByText('Review chloroplasts')).toBeTruthy()
    expect(mocks.search).toHaveBeenCalledWith({ text: 'exam', tag: 'bio', limit: 50 })
    expect(screen.getByText('#bio exam')).toBeTruthy()
    expect(screen.getByText('2 blocks')).toBeTruthy()
    expect(screen.getAllByText('Cell Biology')).toHaveLength(2)
  })

  it('opens the source note of a row', async () => {
    mocks.search.mockResolvedValue({ results: [item('b1', 'Stroma')], truncated: false })
    renderView()

    fireEvent.click(await screen.findByText('Stroma'))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n1' }),
      undefined
    )
  })

  it('runs the query again when a note changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mocks.search.mockResolvedValue({ results: [item('b1', 'Stroma')], truncated: false })
      renderView()
      await screen.findByText('Stroma')
      expect(mocks.search).toHaveBeenCalledTimes(1)

      mocks.search.mockResolvedValue({ results: [item('b9', 'Granum')], truncated: false })
      act(() => mocks.noteUpdated?.())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })

      expect(await screen.findByText('Granum')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so when the search cannot run, and offers a retry', async () => {
    mocks.search.mockRejectedValueOnce(new Error('portals API is not available in this build'))
    renderView()

    expect((await screen.findByRole('alert')).textContent).toContain('could not run')
    mocks.search.mockResolvedValue({ results: [], truncated: false })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('No blocks match this query.')).toBeTruthy()
  })
})

describe('searchQueryLabel', () => {
  it('writes the tag first, as a #tag', () => {
    expect(searchQueryLabel({ kind: 'search', tag: 'bio', limit: 5 })).toBe('#bio')
    expect(searchQueryLabel(target)).toBe('#bio exam')
  })
})
