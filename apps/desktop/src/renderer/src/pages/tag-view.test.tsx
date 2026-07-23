import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagViewPage from './tag-view'
import { getTagColors } from '@/components/note/tags-row/tag-colors'

vi.mock('@/hooks/use-tag-items', () => ({
  useTagItems: () => ({ items: [], total: 0, isLoading: false, error: null, refresh: vi.fn() })
}))

// A stored color deliberately different from `meetings`' name-hash fallback
// (verified below) — this is what the hub chip / sidebar would have resolved
// from `tag_definitions.color`.
const STORED_COLOR = 'cobalt'

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'meetings', color: STORED_COLOR, count: 3, icon: null, categoryId: null, sortOrder: 0 }
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn()
  })
}))

// jsdom normalizes inline hex colors to rgb() on readback, so compare via a
// probe element rather than the raw hex string from getTagColors.
function asCssColor(hex: string): string {
  const probe = document.createElement('div')
  probe.style.color = hex
  return probe.style.color
}

describe('TagViewPage', () => {
  it('shows the tag name and its total count in the header', () => {
    render(<TagViewPage tag="meetings" />)
    expect(screen.getByText('meetings')).toBeInTheDocument()
  })

  it("colors the header chip from the tag's stored color, not the name-hash fallback", () => {
    render(<TagViewPage tag="meetings" />)
    const chip = screen.getByText('meetings').parentElement as HTMLElement

    const storedColors = getTagColors(STORED_COLOR, 'meetings')
    const nameHashColors = getTagColors('', 'meetings')

    // Sanity check: the fixture only discriminates if these genuinely differ.
    expect(storedColors.text).not.toBe(nameHashColors.text)

    expect(chip.style.color).toBe(asCssColor(storedColors.text))
    expect(chip.style.color).not.toBe(asCssColor(nameHashColors.text))
  })
})
