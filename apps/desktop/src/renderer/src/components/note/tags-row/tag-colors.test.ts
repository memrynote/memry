import { describe, it, expect } from 'vitest'
import {
  TAG_COLORS,
  COLOR_NAMES,
  defaultTagColorName,
  getTagColors,
  isHexColor
} from './tag-colors'

describe('defaultTagColorName', () => {
  it('is deterministic for the same tag name', () => {
    expect(defaultTagColorName('research')).toBe(defaultTagColorName('research'))
  })

  it('is case-insensitive — case variants of one tag share a color', () => {
    expect(defaultTagColorName('Test')).toBe(defaultTagColorName('test'))
    expect(defaultTagColorName('TEST')).toBe(defaultTagColorName('test'))
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

  it('uses a custom hex verbatim for text and background', () => {
    expect(getTagColors('#6b7280', 'research')).toEqual({
      background: '#6b7280',
      text: '#6b7280'
    })
  })

  it('prefers a known palette name over the hex branch', () => {
    expect(getTagColors('rose', 'research')).toBe(TAG_COLORS.rose)
  })

  it('falls back to stone only when no tag name is available', () => {
    expect(getTagColors('')).toBe(TAG_COLORS.stone)
  })
})

describe('isHexColor', () => {
  it('accepts 6-digit hex', () => {
    expect(isHexColor('#ff6600')).toBe(true)
    expect(isHexColor('#FFFFFF')).toBe(true)
  })

  it('rejects names, partial hex, and empty', () => {
    expect(isHexColor('rose')).toBe(false)
    expect(isHexColor('#fff')).toBe(false)
    expect(isHexColor('ff6600')).toBe(false)
    expect(isHexColor('')).toBe(false)
  })
})
