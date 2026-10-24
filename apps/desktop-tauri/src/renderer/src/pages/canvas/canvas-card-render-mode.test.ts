import { describe, expect, it } from 'vitest'

import { RICH_MAX_CARDS, RICH_MIN_ZOOM, shouldRenderRich } from './canvas-card-render-mode'

describe('shouldRenderRich', () => {
  it('renders rich at normal zoom with a handful of cards', () => {
    expect(shouldRenderRich({ zoom: 1, visibleCount: 3 })).toBe(true)
  })

  it('falls back below the legibility zoom', () => {
    expect(shouldRenderRich({ zoom: RICH_MIN_ZOOM - 0.01, visibleCount: 1 })).toBe(false)
    expect(shouldRenderRich({ zoom: RICH_MIN_ZOOM, visibleCount: 1 })).toBe(true)
  })

  it('falls back once too many cards are mounted', () => {
    expect(shouldRenderRich({ zoom: 1, visibleCount: RICH_MAX_CARDS })).toBe(true)
    expect(shouldRenderRich({ zoom: 1, visibleCount: RICH_MAX_CARDS + 1 })).toBe(false)
  })

  it('treats a non-finite zoom as unsafe', () => {
    expect(shouldRenderRich({ zoom: Number.NaN, visibleCount: 1 })).toBe(false)
  })
})
