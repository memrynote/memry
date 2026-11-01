import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagCategories } from './use-tag-categories'

// The hook over the real tags service, down to the Rust command: the command takes the
// category id and the new name as two strings, so a swap anywhere on the way type-checks.
const commands = vi.hoisted(() => ({
  tagsListCategories: vi.fn().mockResolvedValue([]),
  tagsRenameCategory: vi.fn().mockResolvedValue(null)
}))
const events = vi.hoisted(() => ({
  tagCategoriesChangedEvent: { listen: async () => () => {} }
}))
vi.mock('../../../generated/bindings', () => ({ commands, events }))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [], isLoading: false, error: null, refetch: vi.fn() })
}))

describe('useTagCategories commands', () => {
  it('renames a category with its id first and the new name second', async () => {
    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await result.current.renameCategory('cat-1', 'Jobs')

    expect(commands.tagsRenameCategory).toHaveBeenCalledWith('cat-1', 'Jobs')
    expect(result.current.error).toBeNull()
  })
})
