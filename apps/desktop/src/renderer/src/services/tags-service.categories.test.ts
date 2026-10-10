import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTagCategories } from '@/hooks/use-tag-categories'

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [], isLoading: false, error: null, refetch: vi.fn() })
}))

type Fn = ReturnType<typeof vi.fn>
const api = window.api as unknown as { tags: Record<string, Fn>; onTagCategoriesChanged: Fn }

let categoriesChanged: () => void

beforeEach(() => {
  api.tags.listCategories = vi.fn().mockResolvedValue({
    success: true,
    categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 0 }]
  })
  api.tags.createCategory = vi.fn().mockResolvedValue({ success: true })
  api.tags.renameCategory = vi.fn().mockResolvedValue({ success: true })
  api.tags.deleteCategory = vi.fn().mockResolvedValue({ success: true })
  api.onTagCategoriesChanged = vi.fn((callback: () => void) => {
    categoriesChanged = callback
    return () => {}
  })
})

// The hub hands the service flat arguments; the preload API takes one object per call.
describe('tag categories through the real tags service', () => {
  it('creates, renames and deletes a category with the argument shape the IPC expects', async () => {
    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.categories).toHaveLength(1))

    await act(() => result.current.createCategory('Blog'))
    await act(() => result.current.renameCategory('cat-1', 'Projects'))
    await act(() => result.current.deleteCategory('cat-1'))

    expect(api.tags.createCategory).toHaveBeenCalledWith({ name: 'Blog' })
    expect(api.tags.renameCategory).toHaveBeenCalledWith({ id: 'cat-1', name: 'Projects' })
    expect(api.tags.deleteCategory).toHaveBeenCalledWith({ id: 'cat-1' })
  })

  it('reloads the categories after one is created', async () => {
    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.categories).toHaveLength(1))
    api.tags.listCategories.mockResolvedValue({
      success: true,
      categories: [
        { id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 0 },
        { id: 'cat-2', name: 'Blog', sortOrder: 1, tagCount: 0 }
      ]
    })

    await act(() => result.current.createCategory('Blog'))

    expect(result.current.categories.map((c) => c.name)).toEqual(['Work', 'Blog'])
  })

  it('reloads the categories when another window changes them', async () => {
    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.categories).toHaveLength(1))
    api.tags.listCategories.mockResolvedValue({ success: true, categories: [] })

    act(() => categoriesChanged())

    await waitFor(() => expect(result.current.categories).toHaveLength(0))
  })
})
