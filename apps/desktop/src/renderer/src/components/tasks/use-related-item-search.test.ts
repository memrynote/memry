import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { notesService } from '@/services/notes-service'
import { canvasService } from '@/services/canvas-service'
import { searchService } from '@/services/search-service'
import { useRelatedItemSearch } from '@/components/tasks/use-related-item-search'

vi.mock('@/services/notes-service', () => ({
  notesService: { list: vi.fn() }
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { list: vi.fn() }
}))

vi.mock('@/services/search-service', () => ({
  searchService: { query: vi.fn() }
}))

const noteRow = (id: string, title: string) => ({
  id,
  title,
  emoji: null,
  fileType: 'markdown' as const
})

const canvasRow = (id: string, title: string | null) => ({
  id,
  title,
  icon: null
})

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

// Rejecting on a timer rather than with mockRejectedValue: an immediate
// rejection settles before the other source's `.then` chain does, which would
// hide a handler that wrongly clears its sibling's results.
const rejectsLate = (message: string) => () =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), 10)
  })

describe('useRelatedItemSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(notesService.list as Mock).mockResolvedValue({ notes: [noteRow('n1', 'Recent note')] })
    ;(canvasService.list as Mock).mockResolvedValue({ canvases: [canvasRow('c1', 'Roadmap')] })
    ;(searchService.query as Mock).mockResolvedValue({ groups: [] })
  })

  it('returns nothing and queries nothing while the picker is closed', () => {
    const { result } = renderHook(() => useRelatedItemSearch(false, '', 'Untitled canvas'))

    expect(result.current).toEqual({ notes: [], canvases: [] })
    expect(notesService.list).not.toHaveBeenCalled()
    expect(canvasService.list).not.toHaveBeenCalled()
  })

  it('lists recent notes and canvases for the empty query', async () => {
    const { result } = renderHook(() => useRelatedItemSearch(true, '', 'Untitled canvas'))

    await waitFor(() => expect(result.current.notes).toHaveLength(1))

    expect(result.current.notes[0]).toMatchObject({ kind: 'note', id: 'n1', title: 'Recent note' })
    expect(result.current.canvases[0]).toMatchObject({ kind: 'canvas', id: 'c1', title: 'Roadmap' })
    expect(searchService.query).not.toHaveBeenCalled()
  })

  it('searches the whole vault rather than the recent page once a query is typed', async () => {
    ;(searchService.query as Mock).mockResolvedValue({
      groups: [
        {
          type: 'note',
          results: [
            {
              id: 'old-note',
              title: 'An ancient note',
              metadata: { type: 'note', emoji: null, fileType: 'markdown' }
            }
          ]
        }
      ]
    })

    const { result } = renderHook(() => useRelatedItemSearch(true, 'ancient', 'Untitled canvas'))

    await waitFor(() => expect(result.current.notes).toHaveLength(1))

    expect(result.current.notes[0]).toMatchObject({ id: 'old-note', title: 'An ancient note' })
    expect(searchService.query).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ancient', types: ['note'] })
    )
    expect(notesService.list).not.toHaveBeenCalled()
  })

  it('falls back to the untitled label for a canvas with no title', async () => {
    ;(canvasService.list as Mock).mockResolvedValue({ canvases: [canvasRow('c2', null)] })

    const { result } = renderHook(() => useRelatedItemSearch(true, '', 'Untitled canvas'))

    await waitFor(() => expect(result.current.canvases).toHaveLength(1))
    expect(result.current.canvases[0].title).toBe('Untitled canvas')
  })

  it('keeps the notes when the canvas source fails', async () => {
    ;(canvasService.list as Mock).mockImplementation(rejectsLate('canvas list exploded'))

    const { result } = renderHook(() => useRelatedItemSearch(true, '', 'Untitled canvas'))

    await waitFor(() => expect(result.current.notes).toHaveLength(1))
    // Both sources have to have settled before this means anything: the whole
    // point is that the canvas rejection does not go back and clear the notes.
    await settle()

    expect(result.current.notes).toHaveLength(1)
    expect(result.current.canvases).toEqual([])
  })

  it('keeps the canvases when the note source fails', async () => {
    ;(notesService.list as Mock).mockImplementation(rejectsLate('note list exploded'))

    const { result } = renderHook(() => useRelatedItemSearch(true, '', 'Untitled canvas'))

    await waitFor(() => expect(result.current.canvases).toHaveLength(1))
    await settle()

    expect(result.current.canvases).toHaveLength(1)
    expect(result.current.notes).toEqual([])
  })

  it('matches canvases against the typed query', async () => {
    ;(canvasService.list as Mock).mockResolvedValue({
      canvases: [canvasRow('c1', 'Roadmap'), canvasRow('c2', 'Budget')]
    })

    const { result } = renderHook(() => useRelatedItemSearch(true, 'road', 'Untitled canvas'))

    await waitFor(() => expect(result.current.canvases).toHaveLength(1))
    expect(result.current.canvases[0].id).toBe('c1')
  })
})
