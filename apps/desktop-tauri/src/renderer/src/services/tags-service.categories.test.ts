import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteMetadataEvents } from '@/hooks/use-note-metadata-events'
import { useTagCategories } from '@/hooks/use-tag-categories'

vi.mock(import('@/hooks/use-notes-query'), async (importOriginal) => ({
  ...(await importOriginal()),
  useNoteTagsQuery: () => ({ tags: [], isLoading: false, error: null, refetch: vi.fn() })
}))

// The folder list's event is not one this test is about, and the DOM setup has no binding for it.
vi.mock(import('@/services/notes-service'), async (importOriginal) => ({
  ...(await importOriginal()),
  onFolderConfigUpdated: () => () => undefined
}))

/** The categories as the app has them: the hook, and the owner of the event that refreshes them. */
function renderCategories() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      useNoteMetadataEvents()
      return useTagCategories()
    },
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children)
    }
  )
}

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

describe('tag categories through the real tags service', () => {
  it('reloads the categories after one is created', async () => {
    const { result } = renderCategories()
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
    const { result } = renderCategories()
    await waitFor(() => expect(result.current.categories).toHaveLength(1))
    api.tags.listCategories.mockResolvedValue({ success: true, categories: [] })

    act(() => categoriesChanged())

    await waitFor(() => expect(result.current.categories).toHaveLength(0))
  })
})
