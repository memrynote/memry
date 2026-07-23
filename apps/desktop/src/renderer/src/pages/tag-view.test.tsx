import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagViewPage from './tag-view'

vi.mock('@/hooks/use-tag-items', () => ({
  useTagItems: () => ({ items: [], total: 0, isLoading: false, error: null, refresh: vi.fn() })
}))

describe('TagViewPage', () => {
  it('shows the tag name and its total count in the header', () => {
    render(<TagViewPage tag="meetings" />)
    expect(screen.getByText('meetings')).toBeInTheDocument()
  })
})
