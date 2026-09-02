import { describe, it, expect } from 'vitest'
import {
  FONT_SIZE_PX_MIN,
  FONT_SIZE_PX_MAX,
  FONT_SIZE_PX_DEFAULT,
  LEGACY_FONT_SIZE_PX,
  resolveFontSizePx,
  toLegacyFontSize
} from './font-size'

describe('resolveFontSizePx', () => {
  it('returns an in-range pixel value untouched', () => {
    expect(resolveFontSizePx(18, 'medium')).toBe(18)
    expect(resolveFontSizePx(FONT_SIZE_PX_MIN, undefined)).toBe(FONT_SIZE_PX_MIN)
    expect(resolveFontSizePx(FONT_SIZE_PX_MAX, undefined)).toBe(FONT_SIZE_PX_MAX)
  })

  it('rounds a fractional pixel value to the integer both schemas declare', () => {
    expect(resolveFontSizePx(16.4, undefined)).toBe(16)
    expect(resolveFontSizePx(16.5, undefined)).toBe(17)
    expect(resolveFontSizePx(11.6, undefined)).toBe(FONT_SIZE_PX_MIN)
    expect(resolveFontSizePx(24.4, undefined)).toBe(FONT_SIZE_PX_MAX)
  })

  it('clamps a pixel value at both ends', () => {
    expect(resolveFontSizePx(4, undefined)).toBe(FONT_SIZE_PX_MIN)
    expect(resolveFontSizePx(-100, undefined)).toBe(FONT_SIZE_PX_MIN)
    expect(resolveFontSizePx(999, undefined)).toBe(FONT_SIZE_PX_MAX)
  })

  it('ignores a non-finite pixel value and falls back', () => {
    expect(resolveFontSizePx(Number.NaN, 'large')).toBe(LEGACY_FONT_SIZE_PX.large)
    expect(resolveFontSizePx(Number.POSITIVE_INFINITY, 'small')).toBe(LEGACY_FONT_SIZE_PX.small)
    expect(resolveFontSizePx(Number.NEGATIVE_INFINITY, undefined)).toBe(FONT_SIZE_PX_DEFAULT)
  })

  it('migrates each legacy bucket when no pixel value was written', () => {
    expect(resolveFontSizePx(undefined, 'small')).toBe(14)
    expect(resolveFontSizePx(undefined, 'medium')).toBe(16)
    expect(resolveFontSizePx(undefined, 'large')).toBe(20)
  })

  it('falls back to the default when neither value is usable', () => {
    expect(resolveFontSizePx(undefined, undefined)).toBe(FONT_SIZE_PX_DEFAULT)
    expect(resolveFontSizePx(undefined, 'gigantic')).toBe(FONT_SIZE_PX_DEFAULT)
  })

  it('keeps a pixel value whose bucket agrees with it', () => {
    expect(resolveFontSizePx(22, 'large')).toBe(22)
    expect(resolveFontSizePx(13, 'small')).toBe(13)
  })

  it('lets a disagreeing bucket win, because only an older build can write one', () => {
    expect(resolveFontSizePx(22, 'small')).toBe(14)
    expect(resolveFontSizePx(13, 'large')).toBe(20)
  })

  it('keeps a pixel value the bucket cannot contradict', () => {
    expect(resolveFontSizePx(22, undefined)).toBe(22)
    expect(resolveFontSizePx(22, 'nonsense')).toBe(22)
  })

  it('rounds before checking the bucket, so a fraction can satisfy its own invariant', () => {
    expect(resolveFontSizePx(16.4, 'medium')).toBe(16)
  })

  it('maps every pixel value in range to a bucket that agrees with it', () => {
    for (let px = FONT_SIZE_PX_MIN; px <= FONT_SIZE_PX_MAX; px++) {
      expect(resolveFontSizePx(px, toLegacyFontSize(px))).toBe(px)
    }
  })
})

describe('toLegacyFontSize', () => {
  it('maps each bucket to itself', () => {
    expect(toLegacyFontSize(14)).toBe('small')
    expect(toLegacyFontSize(16)).toBe('medium')
    expect(toLegacyFontSize(20)).toBe('large')
  })

  it('resolves a midpoint to the smaller bucket', () => {
    expect(toLegacyFontSize(15)).toBe('small')
    expect(toLegacyFontSize(18)).toBe('medium')
  })

  it('picks the nearest bucket across the whole range', () => {
    const expected: Record<number, string> = {
      12: 'small',
      13: 'small',
      14: 'small',
      15: 'small',
      16: 'medium',
      17: 'medium',
      18: 'medium',
      19: 'large',
      20: 'large',
      21: 'large',
      22: 'large',
      23: 'large',
      24: 'large'
    }
    for (let px = FONT_SIZE_PX_MIN; px <= FONT_SIZE_PX_MAX; px++) {
      expect(toLegacyFontSize(px)).toBe(expected[px])
    }
  })
})
