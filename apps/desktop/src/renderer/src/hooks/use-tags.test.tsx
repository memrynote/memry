import { act, renderHook, waitFor } from '@testing-library/react'
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
    onTagsChanged: ReturnType<typeof vi.fn>
    onTagRenamed: ReturnType<typeof vi.fn>
    onTagDeleted: ReturnType<typeof vi.fn>
  }

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
    api.onTagsChanged = vi.fn(() => () => {})
    api.onTagRenamed = vi.fn(() => () => {})
    api.onTagDeleted = vi.fn(() => () => {})
  })

  it('loads tags, subscribes to tag events, and exposes sorted searches', async () => {
    const { result } = renderHook(() => useTags())

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
    expect(result.current.getRecentTags(1)).toEqual([{ name: 'work', count: 8 }])

    const api = getApi()
    expect(api.onTagsChanged).toHaveBeenCalledTimes(1)
    expect(api.onTagRenamed).toHaveBeenCalledTimes(1)
    expect(api.onTagDeleted).toHaveBeenCalledTimes(1)
  })

  it('refetches on events and forwards rename, merge, and delete operations', async () => {
    let onChanged: (() => void) | undefined
    const api = getApi()
    api.onTagsChanged.mockImplementation((callback: () => void) => {
      onChanged = callback
      return () => {}
    })

    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    api.tags.getAllWithCounts.mockResolvedValueOnce({
      tags: [{ name: 'refreshed', count: 1 }]
    })
    await act(async () => {
      onChanged?.()
    })

    await waitFor(() => expect(result.current.tags).toEqual([{ name: 'refreshed', count: 1 }]))

    await act(async () => {
      await result.current.renameTag('old', 'new')
      await result.current.mergeTag('source', 'target')
      await result.current.deleteTag('old')
    })

    expect(api.tags.renameTag).toHaveBeenCalledWith({ oldName: 'old', newName: 'new' })
    expect(api.tags.mergeTag).toHaveBeenCalledWith({ source: 'source', target: 'target' })
    expect(api.tags.deleteTag).toHaveBeenCalledWith('old')
  })

  it('reports load errors without keeping the hook in loading state', async () => {
    const api = getApi()
    api.tags.getAllWithCounts.mockRejectedValueOnce(new Error('tag load failed'))

    const { result } = renderHook(() => useTags())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBe('tag load failed')
    expect(result.current.tags).toEqual([])
  })
})
