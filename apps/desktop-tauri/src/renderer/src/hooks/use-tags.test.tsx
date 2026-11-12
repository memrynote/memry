import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTags } from './use-tags'

const getApi = () =>
  window.api as unknown as {
    tags: {
      getAllWithCounts: ReturnType<typeof vi.fn>
      renameTag: ReturnType<typeof vi.fn>
      mergeTag: ReturnType<typeof vi.fn>
      deleteTag: ReturnType<typeof vi.fn>
    }
  }

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

describe('useTags', () => {
  beforeEach(() => {
    const api = getApi()
    api.tags.getAllWithCounts = vi.fn().mockResolvedValue({
      tags: [
        { name: 'work', count: 8 },
        { name: 'work/design', count: 3 },
        { name: 'work/dev', count: 5 },
        { name: 'work/dev/frontend', count: 2 },
        { name: 'personal', count: 6 }
      ]
    })
    api.tags.renameTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.mergeTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.deleteTag = vi.fn().mockResolvedValue({ success: true })
  })

  it('loads tags and exposes sorted searches', async () => {
    const { result } = renderHook(() => useTags(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.tags).toHaveLength(5)
    expect(result.current.searchTags('').map((tag) => tag.name)).toEqual([
      'work',
      'personal',
      'work/dev',
      'work/design',
      'work/dev/frontend'
    ])
    expect(result.current.searchTags('work/').map((tag) => tag.name)).toEqual([
      'work/dev',
      'work/design'
    ])
    expect(result.current.searchTags('work/d').map((tag) => tag.name)).toEqual([
      'work/dev',
      'work/design'
    ])
    expect(result.current.getPopularTags(2).map((tag) => tag.name)).toEqual(['work', 'personal'])
    expect(result.current.getRecentTags(1).map((tag) => tag.name)).toEqual(['work'])
  })

  it('forwards merge and delete operations', async () => {
    const api = getApi()
    const { result } = renderHook(() => useTags(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.mergeTag('source', 'target')
      await result.current.deleteTag('old')
    })

    expect(api.tags.mergeTag).toHaveBeenCalledWith({ source: 'source', target: 'target' })
    expect(api.tags.deleteTag).toHaveBeenCalledWith('old')
  })

  it('reports load errors without keeping the hook in loading state', async () => {
    const api = getApi()
    api.tags.getAllWithCounts.mockRejectedValueOnce(new Error('tag load failed'))

    const { result } = renderHook(() => useTags(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('tag load failed')
    expect(result.current.tags).toEqual([])
  })
})
