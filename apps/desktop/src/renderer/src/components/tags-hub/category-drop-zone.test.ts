import { describe, it, expect } from 'vitest'
import { tagDropZoneClasses } from './category-block'

// `isOver` only flips during a live pointer drag, which jsdom cannot drive,
// so the class decision lives in a pure helper and is asserted here. These
// compare outputs against each other rather than pinning literal class
// strings — the branch has to exist, the styling stays free to change.
describe('tagDropZoneClasses', () => {
  it('marks a category that already has chips while a tag hovers it', () => {
    // The bug this fixes: highlighting used to be gated on the category
    // being empty, so dragging onto a populated category showed nothing.
    expect(tagDropZoneClasses({ isOver: true, isEmpty: false })).not.toBe(
      tagDropZoneClasses({ isOver: false, isEmpty: false })
    )
  })

  it('marks an empty category while a tag hovers it', () => {
    expect(tagDropZoneClasses({ isOver: true, isEmpty: true })).not.toBe(
      tagDropZoneClasses({ isOver: false, isEmpty: true })
    )
  })

  it('gives an empty category different geometry from a populated one', () => {
    expect(tagDropZoneClasses({ isOver: false, isEmpty: true })).not.toBe(
      tagDropZoneClasses({ isOver: false, isEmpty: false })
    )
  })
})
