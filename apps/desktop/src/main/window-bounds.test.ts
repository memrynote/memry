import { describe, it, expect } from 'vitest'
import { resolveStartupBounds, type DisplayLike, type SavedWindowBounds } from './window-bounds'

const FALLBACK = { width: 1550, height: 900 }

// A single 1440x900 display whose work area starts at the origin.
const PRIMARY: DisplayLike = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }

describe('resolveStartupBounds', () => {
  it('returns the fallback size, centered, when there are no saved bounds', () => {
    const result = resolveStartupBounds(null, [PRIMARY], FALLBACK)
    expect(result).toEqual({ width: 1550, height: 900, maximize: false })
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
  })

  it('restores saved size and position that sit on a display', () => {
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 100, y: 60 }
    expect(resolveStartupBounds(saved, [PRIMARY], FALLBACK)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      maximize: false
    })
  })

  it('drops an off-screen position but keeps the saved size', () => {
    // x=5000 is far past the only 1440-wide display → not visible.
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 5000, y: 60 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(1200)
    expect(result.height).toBe(800)
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
    expect(result.maximize).toBe(false)
  })

  it('passes through the maximized flag while keeping the normal bounds', () => {
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 100, y: 60, isMaximized: true }
    expect(resolveStartupBounds(saved, [PRIMARY], FALLBACK)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      maximize: true
    })
  })

  it('keeps the size when a position was never saved', () => {
    const saved: SavedWindowBounds = { width: 1300, height: 850 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(1300)
    expect(result.height).toBe(850)
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
  })

  it('accepts a position on a secondary display to the right of the primary', () => {
    const secondary: DisplayLike = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
    const saved: SavedWindowBounds = { width: 1000, height: 700, x: 1600, y: 120 }
    expect(resolveStartupBounds(saved, [PRIMARY, secondary], FALLBACK)).toMatchObject({
      x: 1600,
      y: 120
    })
  })

  it('drops an absurdly small saved size in favour of the fallback', () => {
    const saved: SavedWindowBounds = { width: 20, height: 10, x: 100, y: 60 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(FALLBACK.width)
    expect(result.height).toBe(FALLBACK.height)
  })
})
