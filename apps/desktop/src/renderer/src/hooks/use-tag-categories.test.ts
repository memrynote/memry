import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagCategories } from './use-tag-categories'

const listCategories = vi.fn()
const updateTagColor = vi.fn()
const reorder = vi.fn()
const refetchNoteTags = vi.fn()

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    listCategories: (...a: unknown[]) => listCategories(...a),
    createCategory: vi.fn().mockResolvedValue({ success: true }),
    renameCategory: vi.fn().mockResolvedValue({ success: true }),
    deleteCategory: vi.fn().mockResolvedValue({ success: true }),
    updateTagColor: (...a: unknown[]) => updateTagColor(...a),
    reorder: (...a: unknown[]) => reorder(...a)
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
    error: null,
    refetch: (...a: unknown[]) => refetchNoteTags(...a)
  })
}))

beforeEach(() => {
  listCategories.mockResolvedValue({
    success: true,
    categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 1 }]
  })
  updateTagColor.mockReset()
  reorder.mockReset()
  refetchNoteTags.mockReset()
})

describe('useTagCategories', () => {
  it('groups tags under their category and leaves the rest uncategorized', async () => {
    const { result } = renderHook(() => useTagCategories())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.categories).toHaveLength(1)
    expect(result.current.categories[0].tags.map((t) => t.tag)).toEqual(['meetings'])
    expect(result.current.uncategorized.map((t) => t.tag)).toEqual(['idea'])
  })

  it('never returns to the loading state once loaded, so a create updates in place', async () => {
    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Hold the post-create refetch open, so if the hook flipped isLoading
    // back on we'd observe it here rather than racing past it. The hub
    // renders `isLoading ? "Loading tags…" : <the whole list>`, so a true
    // value at any point after the first load blanks and rebuilds the page.
    let releaseRefetch: (() => void) | undefined
    listCategories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRefetch = () =>
            resolve({
              success: true,
              categories: [
                { id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 1 },
                { id: 'cat-2', name: 'Blog', sortOrder: 1, tagCount: 0 }
              ]
            })
        })
    )

    const created = result.current.createCategory('Blog')
    await waitFor(() => expect(releaseRefetch).toBeDefined())
    expect(result.current.isLoading).toBe(false)

    releaseRefetch?.()
    await created

    await waitFor(() => expect(result.current.categories).toHaveLength(2))
    expect(result.current.isLoading).toBe(false)
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

  it('refetches categories when a tag is created but filing it into a category fails', async () => {
    updateTagColor.mockResolvedValue({ success: true })
    reorder.mockResolvedValue({ success: false, error: 'boom' })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const listCategoriesCallsBefore = listCategories.mock.calls.length

    await result.current.createTag('draft', 'blue', 'cat-1')

    // The tag's visibility in the hub comes from useNoteTagsQuery's data, not
    // from listCategories, so refetchNoteTags is the call that actually makes
    // the newly-created tag show up.
    await waitFor(() => expect(refetchNoteTags).toHaveBeenCalled())

    await waitFor(() =>
      expect(listCategories.mock.calls.length).toBeGreaterThan(listCategoriesCallsBefore)
    )
  })

  it('creates a tag from the hub with the casing the user typed, and refetches so it lands without a restart', async () => {
    updateTagColor.mockResolvedValue({ success: true })
    reorder.mockResolvedValue({ success: true })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await result.current.createTag('Reading', 'emerald', null)

    expect(updateTagColor).toHaveBeenCalledWith({ tag: 'Reading', color: 'emerald' })
    expect(reorder).toHaveBeenCalledWith({
      tags: [{ tag: 'Reading', categoryId: null, sortOrder: 0 }]
    })
    await waitFor(() => expect(refetchNoteTags).toHaveBeenCalled())
    expect(result.current.error).toBeNull()
  })

  it('surfaces a failed tag create instead of swallowing it', async () => {
    updateTagColor.mockResolvedValue({ success: false, error: 'disk is full' })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await result.current.createTag('Reading', 'emerald', null)

    await waitFor(() => expect(result.current.error).toBe('disk is full'))
    expect(reorder).not.toHaveBeenCalled()
  })
})
