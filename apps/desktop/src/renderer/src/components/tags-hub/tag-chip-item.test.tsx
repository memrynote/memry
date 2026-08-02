import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TagChipContent } from './tag-chip-item'

const tag = { tag: 'work/1:1', color: 'blue', icon: null, count: 8, sortOrder: 0 }

// The whole point of splitting the chip's visuals out of `TagChipItem` is
// that `DragOverlay` renders them outside any `SortableContext`. Rendering
// with no `DndContext` ancestor at all is the assertion that keeps it that
// way: reintroduce a dnd-kit hook here and these tests throw.
describe('TagChipContent (overlay-safe presentation)', () => {
  it('renders without a DndContext ancestor', () => {
    expect(() => render(<TagChipContent tag={tag} />)).not.toThrow()
  })

  it('shows the full tag name rather than just the leaf segment', () => {
    render(<TagChipContent tag={tag} />)
    expect(screen.getByText('work/1:1')).toBeInTheDocument()
  })

  it('shows the item count', () => {
    render(<TagChipContent tag={tag} />)
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('falls back to a hash when the tag has no icon', () => {
    render(<TagChipContent tag={tag} />)
    expect(screen.getByText('#')).toBeInTheDocument()
  })

  it('renders the tag icon instead of the hash when one is set', () => {
    render(<TagChipContent tag={{ ...tag, icon: '🌱' }} />)
    expect(screen.queryByText('#')).not.toBeInTheDocument()
  })
})
