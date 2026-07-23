import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagCategories } from './use-tag-categories'

const listCategories = vi.fn()

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    listCategories: (...a: unknown[]) => listCategories(...a),
    createCategory: vi.fn().mockResolvedValue({ success: true }),
    renameCategory: vi.fn().mockResolvedValue({ success: true }),
    deleteCategory: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  },
  onTagCategoriesChanged: () => () => {}
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'meetings', count: 12, color: 'blue', icon: null, categoryId: 'cat-1', sortOrder: 0 },
      { tag: 'idea', count: 22, color: 'red', icon: null, categoryId: null, sortOrder: 0 }
    ],
    isLoading: false,
    error: null
  })
}))

beforeEach(() => {
  listCategories.mockResolvedValue({
    success: true,
    categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 1 }]
  })
})

describe('useTagCategories', () => {
  it('groups tags under their category and leaves the rest uncategorized', async () => {
    const { result } = renderHook(() => useTagCategories())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.categories).toHaveLength(1)
    expect(result.current.categories[0].tags.map((t) => t.tag)).toEqual(['meetings'])
    expect(result.current.uncategorized.map((t) => t.tag)).toEqual(['idea'])
  })

  it('treats a tag pointing at a missing category as uncategorized', async () => {
    listCategories.mockResolvedValue({ success: true, categories: [] })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.categories).toHaveLength(0)
    expect(result.current.uncategorized.map((t) => t.tag).sort()).toEqual(['idea', 'meetings'])
  })

  it('surfaces a failed load as an error string', async () => {
    listCategories.mockResolvedValue({ success: false, error: 'boom' })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
