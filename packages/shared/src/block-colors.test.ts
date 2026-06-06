import { describe, it, expect } from 'vitest'
import {
  BLOCK_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  serializeBlockColorsMarker,
  parseBlockColorsMarker
} from './block-colors'

describe('hasNonDefaultColors', () => {
  it('returns false for missing or default colors', () => {
    expect(hasNonDefaultColors({})).toBe(false)
    expect(hasNonDefaultColors({ textColor: 'default', backgroundColor: 'default' })).toBe(false)
  })

  it('returns true when either color is non-default', () => {
    expect(hasNonDefaultColors({ textColor: 'red' })).toBe(true)
    expect(hasNonDefaultColors({ backgroundColor: 'blue', textColor: 'default' })).toBe(true)
  })
})

describe('serializeBlockColorsMarker', () => {
  it('emits only non-default keys', () => {
    expect(serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'default' })).toBe(
      '<!-- colors:{"textColor":"red"} -->'
    )
    expect(serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'blue' })).toBe(
      '<!-- colors:{"textColor":"red","backgroundColor":"blue"} -->'
    )
  })
})

describe('parseBlockColorsMarker', () => {
  it('parses a serialized marker back to colors', () => {
    const marker = serializeBlockColorsMarker({ textColor: 'red', backgroundColor: 'blue' })
    expect(parseBlockColorsMarker(marker)).toEqual({ textColor: 'red', backgroundColor: 'blue' })
  })

  it('returns null for non-marker lines and malformed JSON', () => {
    expect(parseBlockColorsMarker('plain text')).toBeNull()
    expect(parseBlockColorsMarker('<!-- file:{"url":"x"} -->')).toBeNull()
    expect(parseBlockColorsMarker('<!-- colors:{broken} -->')).toBeNull()
  })
})

describe('BLOCK_COLORS_LINE_REGEX', () => {
  it('matches a full marker line only', () => {
    expect(BLOCK_COLORS_LINE_REGEX.test('<!-- colors:{"textColor":"red"} -->')).toBe(true)
    expect(BLOCK_COLORS_LINE_REGEX.test('text <!-- colors:{"textColor":"red"} -->')).toBe(false)
  })
})
