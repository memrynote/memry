import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
})
