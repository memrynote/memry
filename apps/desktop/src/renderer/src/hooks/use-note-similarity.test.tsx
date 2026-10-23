import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  aiEnabled: true,
  getSimilar: vi.fn(),
  getTagSuggestions: vi.fn(),
  updatedListeners: [] as Array<(event: { id: string; changes: Record<string, unknown> }) => void>
}))

vi.mock('@/contexts/ai-settings-context', () => ({
  useAISettingsContext: () => ({ enabled: mocks.aiEnabled, isLoading: false, reload: vi.fn() })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getSimilar: mocks.getSimilar,
    getTagSuggestions: mocks.getTagSuggestions
  },
  onNoteUpdated: (listener: (typeof mocks.updatedListeners)[number]) => {
    mocks.updatedListeners.push(listener)
    return () => {
      mocks.updatedListeners = mocks.updatedListeners.filter((l) => l !== listener)
    }
  }
}))

import { useSimilarNotes, useTagSuggestions } from './use-note-similarity'

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

const similar = { id: 'b', title: 'B', path: 'b.md', emoji: null, snippet: null, similarity: 0.8 }

describe('useSimilarNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.aiEnabled = true
    mocks.updatedListeners = []
  })

  it('returns ready notes and refetches when another note content changes', async () => {
    mocks.getSimilar.mockResolvedValue({ status: 'ready', notes: [similar] })
    const { result } = renderHook(() => useSimilarNotes('a'), { wrapper })

    await waitFor(() => expect(result.current).toEqual([similar]))
    expect(mocks.getSimilar).toHaveBeenCalledTimes(1)

    act(() => mocks.updatedListeners.forEach((l) => l({ id: 'other', changes: { title: 'x' } })))
    act(() => mocks.updatedListeners.forEach((l) => l({ id: 'other', changes: { content: 'x' } })))

    await waitFor(() => expect(mocks.getSimilar).toHaveBeenCalledTimes(2))
  })

  it('asks nothing while embeddings are off', () => {
    mocks.aiEnabled = false
    const { result } = renderHook(() => useSimilarNotes('a'), { wrapper })
    expect(result.current).toEqual([])
    expect(mocks.getSimilar).not.toHaveBeenCalled()
  })
})

describe('useTagSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.aiEnabled = true
  })

  it('returns suggestions only when wanted', async () => {
    const tags = [{ tag: 'sleep', confidence: 0.6, support: 2 }]
    mocks.getTagSuggestions.mockResolvedValue({ status: 'ready', tags })

    const { result } = renderHook(() => useTagSuggestions('a'), { wrapper })
    await waitFor(() => expect(result.current).toEqual(tags))

    const skipped = renderHook(() => useTagSuggestions('z', { enabled: false }), { wrapper })
    expect(skipped.result.current).toEqual([])
    expect(mocks.getTagSuggestions).not.toHaveBeenCalledWith('z')
  })

  it('treats a no-embedding answer as nothing to show', async () => {
    mocks.getTagSuggestions.mockResolvedValue({ status: 'no-embedding', tags: [] })
    const { result } = renderHook(() => useTagSuggestions('a'), { wrapper })
    await waitFor(() => expect(mocks.getTagSuggestions).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })
})
