import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { BookmarkWithItem } from '@memry/contracts/bookmarks-api'
import { BookmarksWidget } from './bookmarks-widget'

const openSidebarItem = vi.fn()

let mockBookmarks: BookmarkWithItem[] = []

vi.mock('@/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({ bookmarks: mockBookmarks, isLoading: false, error: null })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem })
}))

const bookmark = (
  id: string,
  itemType: string,
  itemId: string,
  itemTitle: string | null,
  extra: Partial<BookmarkWithItem> = {}
): BookmarkWithItem => ({
  id,
  itemType,
  itemId,
  itemTitle,
  itemExists: true,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra
})

describe('BookmarksWidget', () => {
  beforeEach(() => {
    openSidebarItem.mockClear()
    mockBookmarks = [
      bookmark('b1', 'task', 't1', 'Alpha'),
      bookmark('b2', 'note', 'n1', 'Beta', { itemMeta: { path: 'notes/beta.md' } }),
      bookmark('b3', 'journal', 'j1', 'Gamma'),
      bookmark('b4', 'note', 'n2', 'Delta')
    ]
  })

  it('lists bookmark titles', () => {
    render(<BookmarksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('exposes the item type via data-item-type and an sr-only label', () => {
    render(<BookmarksWidget config={{}} size="M" />)
    const rows = screen.getAllByTestId('bookmark-item')
    expect(rows[0]).toHaveAttribute('data-item-type', 'task')
    expect(rows[0]).toHaveAttribute('data-item-id', 't1')
    expect(rows[0]).toHaveTextContent('Task')
    expect(rows[2]).toHaveTextContent('Journal')
  })

  it('respects size limit (S slices to 3)', () => {
    render(<BookmarksWidget config={{}} size="S" />)
    expect(screen.getAllByTestId('bookmark-item')).toHaveLength(3)
    expect(screen.queryByText('Delta')).not.toBeInTheDocument()
  })

  it('hides bookmarks whose item no longer exists and fills the limit from the rest', () => {
    mockBookmarks = [
      bookmark('orphan', 'note', 'gone', null, { itemExists: false }),
      ...mockBookmarks
    ]
    render(<BookmarksWidget config={{}} size="S" />)
    const rows = screen.getAllByTestId('bookmark-item')
    expect(rows.map((row) => row.getAttribute('data-item-id'))).toEqual(['t1', 'n1', 'j1'])
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument()
  })

  it('renders the empty state when every bookmark is an orphan', () => {
    mockBookmarks = [bookmark('orphan', 'note', 'gone', null, { itemExists: false })]
    render(<BookmarksWidget config={{}} size="M" />)
    expect(screen.queryByTestId('bookmark-item')).not.toBeInTheDocument()
    expect(screen.getByText('No bookmarks yet.')).toBeInTheDocument()
  })

  it('opens each bookmark type in its own tab type', () => {
    mockBookmarks = [
      bookmark('b1', 'task', 't1', 'Alpha'),
      bookmark('b2', 'note', 'n1', 'Beta', { itemMeta: { path: 'notes/beta.md' } }),
      bookmark('b5', 'folder', 'Research/Mestrado', 'Mestrado', {
        itemMeta: { path: 'Research/Mestrado' }
      }),
      bookmark('b6', 'tag', 'work', 'work')
    ]
    render(<BookmarksWidget config={{}} size="M" />)
    const rows = screen.getAllByTestId('bookmark-item')

    rows[0].click()
    expect(openSidebarItem).toHaveBeenLastCalledWith({
      type: 'tasks',
      title: 'Alpha',
      path: '/task/t1',
      entityId: 't1'
    })
    rows[1].click()
    expect(openSidebarItem).toHaveBeenLastCalledWith({
      type: 'note',
      title: 'Beta',
      path: 'notes/beta.md',
      entityId: 'n1'
    })
    rows[2].click()
    expect(openSidebarItem).toHaveBeenLastCalledWith({
      type: 'folder',
      title: 'Mestrado',
      path: '/folder/Research%2FMestrado',
      entityId: 'Research/Mestrado'
    })
    rows[3].click()
    expect(openSidebarItem).toHaveBeenLastCalledWith({
      type: 'tag',
      title: 'work',
      path: '/tags/work',
      entityId: 'work'
    })
  })

  it('renders an empty state when there are no bookmarks', () => {
    mockBookmarks = []
    render(<BookmarksWidget config={{}} size="M" />)
    expect(screen.queryByTestId('bookmark-item')).not.toBeInTheDocument()
    expect(screen.getByText('No bookmarks yet.')).toBeInTheDocument()
  })
})
