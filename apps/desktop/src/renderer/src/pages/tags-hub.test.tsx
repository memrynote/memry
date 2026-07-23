import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagsHubPage from './tags-hub'

vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: () => ({
    categories: [],
    uncategorized: [],
    isLoading: false,
    error: null,
    createCategory: vi.fn(),
    renameCategory: vi.fn(),
    deleteCategory: vi.fn(),
    createTag: vi.fn(),
    reorder: vi.fn()
  })
}))

describe('TagsHubPage', () => {
  it('renders the create affordances', () => {
    render(<TagsHubPage />)
    expect(screen.getByRole('button', { name: /new category/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new tag/i })).toBeInTheDocument()
  })
})
