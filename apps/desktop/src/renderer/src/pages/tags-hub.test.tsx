import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DragEndEvent } from '@dnd-kit/core'
import TagsHubPage from './tags-hub'

const mockUseTagCategories = vi.hoisted(() =>
  vi.fn(() => ({
    categories: [] as Array<{
      id: string
      name: string
      sortOrder: number
      tags: Array<{
        tag: string
        color: string
        icon: string | null
        count: number
        sortOrder: number
      }>
    }>,
    uncategorized: [] as Array<{
      tag: string
      color: string
      icon: string | null
      count: number
      sortOrder: number
    }>,
    isLoading: false,
    error: null as string | null,
    createCategory: vi.fn(),
    renameCategory: vi.fn(),
    deleteCategory: vi.fn(),
    createTag: vi.fn(),
    reorder: vi.fn()
  }))
)

const mockOpenSidebarItem = vi.fn()

// `handleDragEnd` (the page's drag-end handler) is only reachable through the
// `onDragEnd` prop the page passes to dnd-kit's `DndContext` — there's no
// other way to invoke it without a real pointer drag. Keep everything else
// in the module real (sensors, `useDroppable`/`useSortable`'s internals via
// `@dnd-kit/sortable`, which imports from this same mocked module) so
// `CategoryBlock`/`TagChipItem` still render normally; only swap `DndContext`
// for a stub that captures the callback and renders its children unwrapped
// (dnd-kit's hooks fall back to their documented no-op default context when
// used outside a real `DndContext`, so this doesn't break the render).
const dndMocks = vi.hoisted(() => ({
  onDragEnd: null as null | ((event: DragEndEvent) => void)
}))

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core')
  return {
    ...actual,
    DndContext: (props: {
      onDragEnd?: (event: DragEndEvent) => void
      children?: ReactNode
    }): ReactNode => {
      dndMocks.onDragEnd = props.onDragEnd ?? null
      return props.children
    }
  }
})

vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: mockUseTagCategories
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({
    openSidebarItem: mockOpenSidebarItem
  })
}))

describe('TagsHubPage', () => {
  it('renders the create affordances', () => {
    render(<TagsHubPage />)
    expect(screen.getByRole('button', { name: /new category/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new tag/i })).toBeInTheDocument()
  })

  it('renders category blocks and the uncategorized block, opening a tag tab on click', async () => {
    mockUseTagCategories.mockReturnValueOnce({
      categories: [
        {
          id: 'cat-1',
          name: 'Work',
          sortOrder: 0,
          tags: [{ tag: 'meetings', color: 'blue', icon: null, count: 3, sortOrder: 0 }]
        }
      ],
      uncategorized: [{ tag: 'misc', color: 'stone', icon: null, count: 1, sortOrder: 0 }],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder: vi.fn()
    })

    render(<TagsHubPage />)

    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

    expect(mockOpenSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'meetings',
      path: '/tags/meetings',
      entityId: 'meetings'
    })
  })

  it('wires a real category block rename/delete to the hook, leaving Uncategorized with neither', async () => {
    const renameCategory = vi.fn()
    const deleteCategory = vi.fn()
    mockUseTagCategories.mockReturnValueOnce({
      categories: [
        {
          id: 'cat-1',
          name: 'Work',
          sortOrder: 0,
          tags: [{ tag: 'meetings', color: 'blue', icon: null, count: 3, sortOrder: 0 }]
        }
      ],
      uncategorized: [{ tag: 'misc', color: 'stone', icon: null, count: 1, sortOrder: 0 }],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory,
      deleteCategory,
      createTag: vi.fn(),
      reorder: vi.fn()
    })

    render(<TagsHubPage />)

    // Rename/delete live behind a per-category `⋯` menu, and only the real
    // category ("Work") should have one — confirms the Uncategorized block
    // below it renders no menu at all.
    expect(screen.getAllByRole('button', { name: /category options/i })).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: /category options/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /rename category/i }))
    // `getByRole('textbox')` alone is now ambiguous — the page's search
    // input is also a textbox — so target the rename input by its
    // prefilled value instead.
    const input = screen.getByDisplayValue('Work')
    await userEvent.clear(input)
    await userEvent.type(input, 'Job{Enter}')
    expect(renameCategory).toHaveBeenCalledWith('cat-1', 'Job')

    await userEvent.click(screen.getByRole('button', { name: /category options/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /delete category/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(deleteCategory).toHaveBeenCalledWith('cat-1')
  })

  it('reorders a dragged tag into its dropped category at the resolved index', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined)
    mockUseTagCategories.mockReturnValueOnce({
      categories: [
        {
          id: 'cat-1',
          name: 'Work',
          sortOrder: 0,
          tags: [
            { tag: 'meetings', color: 'blue', icon: null, count: 3, sortOrder: 0 },
            { tag: 'standup', color: 'blue', icon: null, count: 2, sortOrder: 1 }
          ]
        },
        {
          id: 'cat-2',
          name: 'Personal',
          sortOrder: 1,
          tags: [{ tag: 'personal', color: 'green', icon: null, count: 1, sortOrder: 0 }]
        }
      ],
      uncategorized: [],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder
    })

    render(<TagsHubPage />)

    // "meetings" (cat-1) dropped on the "personal" chip (cat-2, index 0) —
    // dnd-kit's real shape for a tag-over-tag drop (see TagChipItem's
    // `useSortable` data).
    await act(async () => {
      dndMocks.onDragEnd?.({
        active: {
          id: 'meetings',
          data: { current: { type: 'tag', tag: 'meetings', categoryId: 'cat-1' } }
        },
        over: {
          id: 'personal',
          data: { current: { type: 'tag', tag: 'personal', categoryId: 'cat-2' } }
        }
      } as DragEndEvent)
    })

    expect(reorder).toHaveBeenCalledWith({
      tags: [
        { tag: 'standup', categoryId: 'cat-1', sortOrder: 0 },
        { tag: 'meetings', categoryId: 'cat-2', sortOrder: 0 },
        { tag: 'personal', categoryId: 'cat-2', sortOrder: 1 }
      ]
    })
  })

  it('reorders categories when a category block is dragged past another', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined)
    mockUseTagCategories.mockReturnValueOnce({
      categories: [
        { id: 'cat-1', name: 'Work', sortOrder: 0, tags: [] },
        { id: 'cat-2', name: 'Personal', sortOrder: 1, tags: [] },
        { id: 'cat-3', name: 'Ideas', sortOrder: 2, tags: [] }
      ],
      uncategorized: [],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder
    })

    render(<TagsHubPage />)

    // "Work" (index 0) dragged past "Ideas" (index 2) — dnd-kit's real shape
    // for a category-over-category drop (see CategoryBlock's `useSortable`
    // data).
    await act(async () => {
      dndMocks.onDragEnd?.({
        active: { id: 'cat-1', data: { current: { type: 'category', categoryId: 'cat-1' } } },
        over: { id: 'cat-3', data: { current: { type: 'category', categoryId: 'cat-3' } } }
      } as DragEndEvent)
    })

    expect(reorder).toHaveBeenCalledWith({
      categories: [
        { id: 'cat-2', sortOrder: 0 },
        { id: 'cat-3', sortOrder: 1 },
        { id: 'cat-1', sortOrder: 2 }
      ]
    })
  })

  it('filters categories and tags by the search query, showing all tags of a matching category', async () => {
    // `mockReturnValue` (not `...Once`): typing drives `setQuery` on the
    // page itself, so each keystroke re-renders `TagsHubPage` and re-calls
    // the hook — a one-time value would be consumed by the first keystroke,
    // leaving later renders with the mock's empty default.
    mockUseTagCategories.mockReturnValue({
      categories: [
        {
          id: 'cat-1',
          name: 'Work',
          sortOrder: 0,
          tags: [
            { tag: 'meetings', color: 'blue', icon: null, count: 3, sortOrder: 0 },
            { tag: 'okr', color: 'blue', icon: null, count: 1, sortOrder: 1 }
          ]
        },
        {
          id: 'cat-2',
          name: 'Books',
          sortOrder: 1,
          tags: [{ tag: 'general', color: 'stone', icon: null, count: 1, sortOrder: 0 }]
        }
      ],
      uncategorized: [{ tag: 'idea', color: 'green', icon: null, count: 1, sortOrder: 0 }],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder: vi.fn()
    })

    render(<TagsHubPage />)

    await userEvent.type(screen.getByRole('textbox', { name: /search/i }), 'work')

    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /meetings/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /okr/ })).toBeInTheDocument()
    expect(screen.queryByText('Books')).not.toBeInTheDocument()
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /idea/ })).not.toBeInTheDocument()
  })

  it('clears the search query on Escape', async () => {
    mockUseTagCategories.mockReturnValue({
      categories: [
        { id: 'cat-1', name: 'Work', sortOrder: 0, tags: [] },
        { id: 'cat-2', name: 'Books', sortOrder: 1, tags: [] }
      ],
      uncategorized: [],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder: vi.fn()
    })

    render(<TagsHubPage />)

    const input = screen.getByRole('textbox', { name: /search/i })
    await userEvent.type(input, 'work')
    expect(screen.queryByText('Books')).not.toBeInTheDocument()

    await userEvent.type(input, '{Escape}')
    expect(input).toHaveValue('')
    expect(screen.getByText('Books')).toBeInTheDocument()
  })

  it('shows the search-empty state when nothing matches', async () => {
    mockUseTagCategories.mockReturnValue({
      categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tags: [] }],
      uncategorized: [{ tag: 'idea', color: 'green', icon: null, count: 1, sortOrder: 0 }],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder: vi.fn()
    })

    render(<TagsHubPage />)

    await userEvent.type(screen.getByRole('textbox', { name: /search/i }), 'nonexistent')

    expect(screen.queryByText('Work')).not.toBeInTheDocument()
    expect(screen.getByText(/no categories or tags match/i)).toBeInTheDocument()
  })

  it('never fires reorder() from a drag end event while a search query is active', async () => {
    const reorder = vi.fn().mockResolvedValue(undefined)
    mockUseTagCategories.mockReturnValueOnce({
      categories: [
        {
          id: 'cat-1',
          name: 'Work',
          sortOrder: 0,
          tags: [
            { tag: 'meetings', color: 'blue', icon: null, count: 3, sortOrder: 0 },
            { tag: 'standup', color: 'blue', icon: null, count: 2, sortOrder: 1 }
          ]
        },
        {
          id: 'cat-2',
          name: 'Personal',
          sortOrder: 1,
          tags: [{ tag: 'personal', color: 'green', icon: null, count: 1, sortOrder: 0 }]
        }
      ],
      uncategorized: [],
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder
    })

    render(<TagsHubPage />)

    await userEvent.type(screen.getByRole('textbox', { name: /search/i }), 'work')

    // Same drag-end payload the unfiltered "reorders a dragged tag" test
    // uses — proves the query-active guard, not the mocked DndContext's
    // `sensors` prop (which this harness ignores entirely), is what stops
    // `reorder()` from firing.
    await act(async () => {
      dndMocks.onDragEnd?.({
        active: {
          id: 'meetings',
          data: { current: { type: 'tag', tag: 'meetings', categoryId: 'cat-1' } }
        },
        over: {
          id: 'personal',
          data: { current: { type: 'tag', tag: 'personal', categoryId: 'cat-2' } }
        }
      } as DragEndEvent)
    })

    expect(reorder).not.toHaveBeenCalled()
  })
})
