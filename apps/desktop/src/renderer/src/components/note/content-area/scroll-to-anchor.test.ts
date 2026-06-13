import { describe, expect, it, vi } from 'vitest'
import { scrollToAnchor } from './scroll-to-anchor'

describe('scrollToAnchor', () => {
  it('scrolls to the pill with the matching anchorId', () => {
    const root = document.createElement('div')
    const pill = document.createElement('span')
    pill.setAttribute('data-anchor-id', 'dm_1')
    pill.scrollIntoView = vi.fn()
    root.appendChild(pill)
    expect(scrollToAnchor(root, 'dm_1')).toBe(true)
    expect(pill.scrollIntoView).toHaveBeenCalled()
  })

  it('returns false when no matching pill', () => {
    expect(scrollToAnchor(document.createElement('div'), 'missing')).toBe(false)
  })
})
