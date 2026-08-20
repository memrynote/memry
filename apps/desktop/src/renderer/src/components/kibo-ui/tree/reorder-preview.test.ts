import { describe, it, expect } from 'vitest'
import { dropSideFor } from './reorder-preview'

describe('drop side from drag rectangles', () => {
  const target = { top: 100, height: 28 }
  const draggedAt = (centerY: number) => ({ top: centerY - 14, height: 28 })

  it('reorders above and below a row that cannot be dropped into', () => {
    expect(
      dropSideFor({ draggedRect: draggedAt(105), targetRect: target, acceptsInside: false })
    ).toBe('before')
    expect(
      dropSideFor({ draggedRect: draggedAt(125), targetRect: target, acceptsInside: false })
    ).toBe('after')
  })

  // A folder's middle claims the drop, but its outer quarters must still
  // reorder — otherwise a folder can never be dragged past.
  it('drops into a folder only from its middle half', () => {
    expect(
      dropSideFor({ draggedRect: draggedAt(103), targetRect: target, acceptsInside: true })
    ).toBe('before')
    expect(
      dropSideFor({ draggedRect: draggedAt(114), targetRect: target, acceptsInside: true })
    ).toBe('inside')
    expect(
      dropSideFor({ draggedRect: draggedAt(126), targetRect: target, acceptsInside: true })
    ).toBe('after')
  })

  // Same input must always give the same answer: the value is derived from
  // rectangles captured at drag start, so applying it cannot change it.
  it('is a pure function of the two rectangles', () => {
    const input = { draggedRect: draggedAt(114), targetRect: target, acceptsInside: true }
    const first = dropSideFor(input)
    expect(dropSideFor(input)).toBe(first)
    expect(dropSideFor(input)).toBe(first)
  })

  it('degenerates safely for a zero-height target', () => {
    expect(
      dropSideFor({
        draggedRect: draggedAt(100),
        targetRect: { top: 100, height: 0 },
        acceptsInside: true
      })
    ).toBe('after')
  })
})
