import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BookmarksWidget } from './bookmarks-widget'

const openTab = vi.fn()

let mockBookmarks: Array<{
  id: string
  itemType: string
  itemId: string
  itemTitle: string | null
}> = []

vi.mock('@/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({ bookmarks: mockBookmarks, isLoading: false, error: null })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab })
}))

describe('BookmarksWidget', () => {
  beforeEach(() => {
    openTab.mockClear()
    mockBookmarks = [
      { id: 'b1', itemType: 'task', itemId: 't1', itemTitle: 'Alpha' },
      { id: 'b2', itemType: 'note', itemId: 'n1', itemTitle: 'Beta' },
      { id: 'b3', itemType: 'journal', itemId: 'j1', itemTitle: 'Gamma' },
      { id: 'b4', itemType: 'note', itemId: 'n2', itemTitle: 'Delta' }
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

  it('opens a tasks tab for task bookmarks and a note tab otherwise', () => {
    render(<BookmarksWidget config={{}} size="M" />)
    const rows = screen.getAllByTestId('bookmark-item')
    rows[0].click()
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'tasks', entityId: 't1' }))
    rows[1].click()
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', path: '/notes/n1' })
    )
  })

  it('renders an empty state when there are no bookmarks', () => {
    mockBookmarks = []
    render(<BookmarksWidget config={{}} size="M" />)
    expect(screen.queryByTestId('bookmark-item')).not.toBeInTheDocument()
    expect(screen.getByText('No bookmarks yet.')).toBeInTheDocument()
  })
})
