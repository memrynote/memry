import { describe, it, expect } from 'vitest'
import { TAG_COLORS, COLOR_NAMES, defaultTagColorName, getTagColors } from './tag-colors'

describe('defaultTagColorName', () => {
  it('is deterministic for the same tag name', () => {
    expect(defaultTagColorName('research')).toBe(defaultTagColorName('research'))
  })

  it('always returns a real palette color name', () => {
    for (const name of ['research', 'tech/typescript', 'a', '', 'travel/japan']) {
      expect(COLOR_NAMES).toContain(defaultTagColorName(name))
    }
  })

  it('spreads tag names across more than one color', () => {
    const used = new Set(
      ['research', 'active', 'fiction', 'tech/sql', 'travel/europe', 'fitness'].map(
        defaultTagColorName
      )
    )
    expect(used.size).toBeGreaterThan(1)
  })
})

describe('getTagColors', () => {
  it('uses an explicit palette name when given one', () => {
    expect(getTagColors('rose', 'anything')).toBe(TAG_COLORS.rose)
  })

  it('derives from the tag name when color is empty (not flat grey)', () => {
    expect(getTagColors('', 'research')).toBe(TAG_COLORS[defaultTagColorName('research')])
  })

  it('derives from the tag name when color is a legacy hex (seed/backend)', () => {
    const colors = getTagColors('#6b7280', 'research')
    expect(colors).toBe(TAG_COLORS[defaultTagColorName('research')])
    expect(colors).not.toBe(TAG_COLORS.stone)
  })

  it('falls back to stone only when no tag name is available', () => {
    expect(getTagColors('')).toBe(TAG_COLORS.stone)
  })
})
